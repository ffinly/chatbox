import { beforeEach, describe, expect, test, vi } from 'vitest'

const { discoverSkillsMock, getSettingsMock, mcpToolsMock, sandboxProviderMock, skillsChangedListeners } = vi.hoisted(
  () => ({
    discoverSkillsMock: vi.fn(),
    getSettingsMock: vi.fn(),
    mcpToolsMock: vi.fn(),
    sandboxProviderMock: {
      type: 'local',
      init: vi.fn(),
      exec: vi.fn(),
      copyBlobIn: vi.fn(),
      checkAvailability: vi.fn(),
      resolveWorkingDirectory: vi.fn(async () => null),
      setExtraWritableDirs: vi.fn(),
      destroy: vi.fn(),
    },
    skillsChangedListeners: new Set<() => void>(),
  })
)

vi.hoisted(() => {
  const storage = {
    getItem: () => null,
    setItem: () => undefined,
    removeItem: () => undefined,
    clear: () => undefined,
  }
  const windowMock: Record<string, unknown> = {
    electronAPI: undefined,
    localStorage: storage,
  }
  ;(globalThis as unknown as { window: Record<string, unknown>; localStorage: typeof storage }).window = windowMock
  ;(globalThis as unknown as { window: Record<string, unknown>; localStorage: typeof storage }).localStorage = storage
  return {}
})

vi.mock('@/platform', () => ({
  default: {
    type: 'web',
    getPlatform: vi.fn().mockResolvedValue('darwin'),
    getVersion: vi.fn().mockResolvedValue('test-version'),
  },
}))

vi.mock('@/storage', () => {
  // In-memory store: agentPersonaStore reads soul/memories through it when
  // capturing the agent persona snapshot.
  const values = new Map<string, unknown>()
  return {
    default: {
      getBlob: vi.fn().mockResolvedValue(null),
      setBlob: vi.fn().mockResolvedValue(undefined),
      getItem: vi.fn((key: string, initialValue: unknown) => Promise.resolve(values.get(key) ?? initialValue)),
      setItem: vi.fn((key: string, value: unknown) => {
        values.set(key, value)
        return Promise.resolve()
      }),
      setItemNow: vi.fn((key: string, value: unknown) => {
        values.set(key, value)
        return Promise.resolve()
      }),
    },
  }
})

vi.mock('@/sandbox', () => ({
  createSandboxProvider: () => sandboxProviderMock,
}))

vi.mock('@/packages/mcp/controller', () => ({
  mcpController: {
    getAvailableTools: mcpToolsMock,
  },
}))

vi.mock('@/packages/skills/controller', () => ({
  subscribeSkillsChanged: (listener: () => void) => {
    skillsChangedListeners.add(listener)
    return () => skillsChangedListeners.delete(listener)
  },
  skillsController: {
    discoverSkills: discoverSkillsMock,
    loadSkill: vi.fn().mockResolvedValue({ metadata: {}, body: '# Skill instructions' }),
    installFromSandbox: vi.fn(),
  },
}))

vi.mock('@/stores/settingsStore', () => ({
  settingsStore: {
    getState: () => ({
      getSettings: getSettingsMock,
    }),
    setState: vi.fn(),
  },
}))

vi.mock('@/stores/settingActions', () => ({
  getExtensionSettings: () => ({
    webSearch: { provider: 'tavily' },
  }),
  getRemoteConfig: vi.fn().mockResolvedValue({}),
  isPro: () => true,
}))

vi.mock('@/packages/user-exec-approval', () => ({
  requestUserExecApproval: vi.fn(),
}))

import { convertToOpenAICompatibleChatMessages } from '@ai-sdk/openai-compatible/internal'
import type { ModelInterface } from '@shared/models/types'
import type { SandboxProvider } from '@shared/sandbox-provider'
import {
  type Config,
  type Message,
  MessageRoleEnum,
  ModelProviderEnum,
  type Session,
  type SessionSettings,
  type Settings,
} from '@shared/types'
import type { ModelDependencies } from '@shared/types/adapters'
import { getMessageText } from '@shared/utils/message'
import { computeEffectiveAgentMode, prepareAgentGenerationHarness } from './agent-harness'

function createMockModel(overrides?: Partial<ModelInterface>): ModelInterface {
  return {
    name: 'Test Model',
    modelId: 'test-model',
    isSupportToolUse: vi.fn().mockReturnValue(true),
    isSupportVision: vi.fn().mockReturnValue(true),
    isSupportSystemMessage: vi.fn().mockReturnValue(true),
    chat: vi.fn(),
    chatStream: vi.fn(),
    paint: vi.fn(),
    ...overrides,
  } as unknown as ModelInterface
}

function createModelDependencies(): ModelDependencies {
  return {
    request: {
      apiRequest: vi.fn(),
      fetchWithOptions: vi.fn(),
    },
    storage: {
      saveImage: vi.fn(),
      getImage: vi.fn(),
    },
    sentry: {
      captureException: vi.fn(),
      withScope: vi.fn(),
    },
    getRemoteConfig: vi.fn(),
  }
}

function createSession(): Session {
  return {
    id: 'session-1',
    name: 'Session',
    type: 'chat',
    messages: [],
    threads: [],
    messageForksHash: {},
  } as unknown as Session
}

beforeEach(() => {
  vi.clearAllMocks()
  for (const listener of skillsChangedListeners) {
    listener()
  }
  sandboxProviderMock.type = 'local'
  sandboxProviderMock.checkAvailability.mockResolvedValue({ available: true })
  sandboxProviderMock.init.mockResolvedValue({ success: true })
  sandboxProviderMock.exec.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' })
  sandboxProviderMock.copyBlobIn.mockResolvedValue({ success: true })
  mcpToolsMock.mockReturnValue({})
  discoverSkillsMock.mockResolvedValue([{ name: 'analysis', description: 'Analyze files' }])
  getSettingsMock.mockReturnValue({
    skills: { enabledSkillNames: ['analysis'] },
  })
})

describe('computeEffectiveAgentMode', () => {
  test('off when the platform does not support agent mode', () => {
    expect(computeEffectiveAgentMode('on', false)).toBe('off')
    expect(computeEffectiveAgentMode('auto', false)).toBe('off')
    expect(computeEffectiveAgentMode('off', false)).toBe('off')
  })

  test('on only when explicitly on and supported', () => {
    expect(computeEffectiveAgentMode('on', true)).toBe('on')
  })

  test('treats auto and off as off when supported (auto only triggers the suggestion)', () => {
    expect(computeEffectiveAgentMode('auto', true)).toBe('off')
    expect(computeEffectiveAgentMode('off', true)).toBe('off')
  })
})

describe('prepareAgentGenerationHarness', () => {
  test('prepares the real context, system prompt, tools, and sandbox gating for an uploaded file', async () => {
    const userMessage: Message = {
      id: 'msg-1',
      role: MessageRoleEnum.User,
      timestamp: Date.now(),
      contentParts: [{ type: 'text', text: 'Analyze this spreadsheet and create an HTML report.' }],
      files: [
        {
          id: 'file-1',
          name: 'sales.xlsx',
          storageKey: 'parsed-sales',
          rawStorageKey: 'raw-sales',
          byteLength: 2048,
          parserType: 'sandbox-raw',
        },
      ],
    } as unknown as Message

    const lockAgentMode = vi.fn()
    const prepared = await prepareAgentGenerationHarness({
      session: createSession(),
      settings: {
        provider: ModelProviderEnum.ChatboxAI,
        modelId: 'test-model',
      } as SessionSettings,
      globalSettings: {} as Settings,
      configs: { uuid: 'config-1' } as Config,
      messages: [userMessage],
      targetMsgIx: 1,
      model: createMockModel(),
      dependencies: createModelDependencies(),
      webBrowsing: false,
      agentModeValue: 'on',
      agentModeLocked: false,
      agentModeSupported: true,
      signal: new AbortController().signal,
      sandboxProviderFactory: () => sandboxProviderMock as unknown as SandboxProvider,
      isPro: () => true,
      sideEffects: {
        lockAgentMode,
      },
    })

    expect(lockAgentMode).toHaveBeenCalledWith('message_sent')
    expect(sandboxProviderMock.checkAvailability).toHaveBeenCalled()
    expect(prepared.debug.effectiveAgentMode).toBe('on')
    expect(prepared.debug.canExecuteCode).toBe(true)
    expect(prepared.debug.instructions).toContain('## Response Language')
    expect(prepared.debug.instructions).toContain("same language as the user's latest message")

    expect(prepared.tools.code_execution).toBeDefined()
    expect(prepared.tools.read_file).toBeDefined()
    expect(prepared.tools.write_file).toBeDefined()
    expect(prepared.tools.load_skill).toBeDefined()
    expect(prepared.tools.install_skill).toBeDefined()

    const lastPromptMessage = prepared.promptMsgs.at(-1)
    expect(lastPromptMessage).toBeDefined()
    const promptText = lastPromptMessage ? getMessageText(lastPromptMessage, true, false) : ''
    expect(promptText).toContain('<ATTACHMENT_FILE>')
    expect(promptText).toContain('<SANDBOX_MODE>true</SANDBOX_MODE>')
    expect(promptText).toContain('<SANDBOX_PATH>sales.xlsx</SANDBOX_PATH>')
    expect(promptText).not.toContain('ATTACHED_FILES')

    const serializedCoreMessages = JSON.stringify(prepared.coreMessages)
    expect(serializedCoreMessages).toContain('Current model: test-model')
    expect(serializedCoreMessages).toContain('## Response Language')
    expect(serializedCoreMessages).toContain("same language as the user's latest message")
    expect(serializedCoreMessages).toContain('code_execution')
    expect(serializedCoreMessages).toContain('Available Skills')
    expect(prepared.systemPrompt).toContain('Current model: test-model')
    expect(prepared.systemPrompt).toContain('## Response Language')

    expect(prepared.chatOptions.tools).toBe(prepared.tools)
    expect(prepared.chatOptions.agentMode).toBe(true)
    expect(prepared.chatOptions.prepareStep).toBeUndefined()
  })

  test('keeps legacy auto mode on the plain chat path when there are no files', async () => {
    const userMessage: Message = {
      id: 'msg-1',
      role: MessageRoleEnum.User,
      timestamp: Date.now(),
      contentParts: [{ type: 'text', text: 'Make a small HTML demo.' }],
    }

    const prepared = await prepareAgentGenerationHarness({
      session: createSession(),
      settings: {
        provider: ModelProviderEnum.ChatboxAI,
        modelId: 'test-model',
      } as SessionSettings,
      globalSettings: {} as Settings,
      configs: { uuid: 'config-1' } as Config,
      messages: [userMessage],
      targetMsgIx: 1,
      model: createMockModel(),
      dependencies: createModelDependencies(),
      webBrowsing: false,
      agentModeValue: 'auto',
      agentModeLocked: false,
      agentModeSupported: true,
      signal: new AbortController().signal,
      sandboxProviderFactory: () => sandboxProviderMock as unknown as SandboxProvider,
      isPro: () => true,
    })

    expect(prepared.debug.effectiveAgentMode).toBe('off')
    expect(prepared.chatOptions.agentMode).toBe(false)
    expect(prepared.tools.code_execution).toBeUndefined()
    expect(prepared.tools.load_skill).toBeUndefined()
    // Memory tools are mode-independent: chat mode can save/recall too.
    expect(prepared.tools.save_memory).toBeDefined()
    expect(prepared.chatOptions.prepareStep).toBeUndefined()

    const serializedCoreMessages = JSON.stringify(prepared.coreMessages)
    expect(serializedCoreMessages).not.toContain('SANDBOX_MODE')
  })

  test('keeps legacy auto mode on the plain chat path for a single simple file', async () => {
    const userMessage: Message = {
      id: 'msg-1',
      role: MessageRoleEnum.User,
      timestamp: Date.now(),
      contentParts: [{ type: 'text', text: 'Summarize this note.' }],
      files: [
        {
          id: 'file-1',
          name: 'note.txt',
          fileType: 'text/plain',
          storageKey: 'note-key',
        },
      ],
    } as Message

    const lockAgentMode = vi.fn()
    const prepared = await prepareAgentGenerationHarness({
      session: createSession(),
      settings: {
        provider: ModelProviderEnum.ChatboxAI,
        modelId: 'test-model',
      } as SessionSettings,
      globalSettings: {} as Settings,
      configs: { uuid: 'config-1' } as Config,
      messages: [userMessage],
      targetMsgIx: 1,
      model: createMockModel(),
      dependencies: createModelDependencies(),
      webBrowsing: false,
      agentModeValue: 'auto',
      agentModeLocked: false,
      agentModeSupported: true,
      signal: new AbortController().signal,
      sandboxProviderFactory: () => sandboxProviderMock as unknown as SandboxProvider,
      isPro: () => true,
      sideEffects: {
        lockAgentMode,
      },
    })

    expect(lockAgentMode).not.toHaveBeenCalled()
    expect(prepared.debug.effectiveAgentMode).toBe('off')
    expect(prepared.tools.code_execution).toBeUndefined()
    expect(prepared.chatOptions.prepareStep).toBeUndefined()
  })

  test('keeps the toolset and context clean when agent mode is manually off', async () => {
    const userMessage: Message = {
      id: 'msg-1',
      role: MessageRoleEnum.User,
      timestamp: Date.now(),
      contentParts: [{ type: 'text', text: 'Answer normally.' }],
    }

    const prepared = await prepareAgentGenerationHarness({
      session: createSession(),
      settings: {
        provider: ModelProviderEnum.ChatboxAI,
        modelId: 'test-model',
      } as SessionSettings,
      globalSettings: {} as Settings,
      configs: { uuid: 'config-1' } as Config,
      messages: [userMessage],
      targetMsgIx: 1,
      model: createMockModel(),
      dependencies: createModelDependencies(),
      webBrowsing: false,
      agentModeValue: 'off',
      agentModeLocked: false,
      agentModeSupported: true,
      signal: new AbortController().signal,
      sandboxProviderFactory: () => sandboxProviderMock as unknown as SandboxProvider,
      isPro: () => true,
    })

    expect(prepared.debug.effectiveAgentMode).toBe('off')
    expect(prepared.debug.canExecuteCode).toBe(false)
    expect(prepared.tools.code_execution).toBeUndefined()
    expect(prepared.tools.read_file).toBeUndefined()
    // Only the mode-independent memory tools remain in chat mode.
    expect(prepared.tools.save_memory).toBeDefined()
    expect(prepared.tools.delete_memory).toBeDefined()
    expect(JSON.stringify(prepared.coreMessages)).not.toContain('SANDBOX_MODE')
  })

  test('disables chatbox_cli while a resumed image task waits for its callback', async () => {
    discoverSkillsMock.mockResolvedValue([
      { name: 'chatbox-product-info', description: 'Operate Chatbox product features' },
    ])
    getSettingsMock.mockReturnValue({
      skills: { enabledSkillNames: ['chatbox-product-info'] },
    })
    const messages: Message[] = [
      {
        id: 'user-1',
        role: MessageRoleEnum.User,
        contentParts: [{ type: 'text', text: 'Generate a red fox image.' }],
      },
      {
        id: 'assistant-1',
        role: MessageRoleEnum.Assistant,
        contentParts: [
          {
            type: 'tool-call',
            state: 'result',
            toolCallId: 'tool-1',
            toolName: 'chatbox_cli',
            args: { argv: ['image', 'generate', '--prompt', 'red fox'] },
            result: {
              ok: true,
              command: 'image generate',
              accepted: true,
              background: true,
              recordId: 'record-1',
              status: 'pending',
              startedAt: 1_000,
              wait: { mode: 'callback', managedBy: 'chatbox', modelShouldPoll: false, pollIntervalMs: 2_000 },
            },
          },
        ],
      },
    ]

    const prepared = await prepareAgentGenerationHarness({
      session: createSession(),
      settings: { provider: ModelProviderEnum.ChatboxAI, modelId: 'test-model' } as SessionSettings,
      globalSettings: {} as Settings,
      configs: { uuid: 'config-1' } as Config,
      messages,
      targetMsgIx: messages.length,
      model: createMockModel(),
      dependencies: {} as never,
      webBrowsing: false,
      agentModeValue: 'on',
      agentModeLocked: true,
      agentModeSupported: true,
      signal: new AbortController().signal,
      preserveLastPromptMessageToolCalls: true,
      sandboxProviderFactory: () => sandboxProviderMock as unknown as SandboxProvider,
      isPro: () => true,
    })

    expect(prepared.tools.chatbox_cli).toBeDefined()
    expect(prepared.chatOptions.prepareStep).toBeDefined()
    const stepSettings = await prepared.chatOptions.prepareStep?.({ steps: [] } as never)
    expect(stepSettings?.activeTools).not.toContain('chatbox_cli')
  })

  test('keeps a still-generating resumed message with its tool calls in the model context', async () => {
    const messages: Message[] = [
      {
        id: 'user-1',
        role: MessageRoleEnum.User,
        contentParts: [{ type: 'text', text: 'Count from 1 to 30 with one tool call each.' }],
      },
      {
        id: 'assistant-1',
        role: MessageRoleEnum.Assistant,
        // A paused-tool-call continuation hands off to the follow-up generation while
        // the message is still flagged generating; its tool results must stay in context.
        generating: true,
        contentParts: [
          {
            type: 'tool-call',
            state: 'result',
            toolCallId: 'tool-26',
            toolName: 'code_execution',
            args: { code: 'console.log(26)' },
            result: { stdout: '26' },
          },
        ],
      },
    ]

    const prepared = await prepareAgentGenerationHarness({
      session: createSession(),
      settings: { provider: ModelProviderEnum.ChatboxAI, modelId: 'test-model' } as SessionSettings,
      globalSettings: {} as Settings,
      configs: { uuid: 'config-1' } as Config,
      messages,
      targetMsgIx: messages.length,
      model: createMockModel(),
      dependencies: {} as never,
      webBrowsing: false,
      agentModeValue: 'on',
      agentModeLocked: true,
      agentModeSupported: true,
      signal: new AbortController().signal,
      preserveLastPromptMessageToolCalls: true,
      sandboxProviderFactory: () => sandboxProviderMock as unknown as SandboxProvider,
      isPro: () => true,
    })

    expect(prepared.promptMsgs.some((message) => message.id === 'assistant-1')).toBe(true)
    const serialized = JSON.stringify(prepared.coreMessages)
    expect(serialized).toContain('tool-26')
    expect(serialized).toContain('console.log(26)')
  })

  test.each([
    { provider: 'opencode-go', modelId: 'deepseek-v4-pro' },
    { provider: ModelProviderEnum.SiliconFlow, modelId: 'deepseek-ai/DeepSeek-R1' },
    { provider: ModelProviderEnum.VolcEngine, modelId: 'deepseek-r1-250528' },
  ])('passes prior DeepSeek reasoning back as reasoning_content through $provider', async ({ provider, modelId }) => {
    const messages: Message[] = [
      {
        id: 'user-1',
        role: MessageRoleEnum.User,
        contentParts: [{ type: 'text', text: 'Solve this carefully.' }],
      },
      {
        id: 'assistant-1',
        role: MessageRoleEnum.Assistant,
        contentParts: [
          { type: 'reasoning', text: 'Prior private reasoning' },
          { type: 'text', text: 'Prior answer' },
        ],
      },
      {
        id: 'user-2',
        role: MessageRoleEnum.User,
        contentParts: [{ type: 'text', text: 'Continue.' }],
      },
    ]

    const prepared = await prepareAgentGenerationHarness({
      session: createSession(),
      settings: { provider, modelId } as SessionSettings,
      globalSettings: {} as Settings,
      configs: { uuid: 'config-1' } as Config,
      messages,
      targetMsgIx: messages.length,
      model: createMockModel({ modelId, apiStyle: 'openai' }),
      dependencies: createModelDependencies(),
      webBrowsing: false,
      agentModeValue: 'off',
      agentModeLocked: false,
      agentModeSupported: true,
      signal: new AbortController().signal,
    })

    const upstreamMessages = convertToOpenAICompatibleChatMessages(prepared.coreMessages)
    expect(upstreamMessages.find((message) => message.role === 'assistant')).toEqual({
      role: 'assistant',
      content: 'Prior answer',
      reasoning_content: 'Prior private reasoning',
    })
  })

  test.each(['grok-4', 'mistral-large-latest', 'gemini-2.5-pro'])(
    'does not pass prior reasoning to an unrelated OpenAI-compatible %s model',
    async (modelId) => {
      const messages: Message[] = [
        {
          id: 'user-1',
          role: MessageRoleEnum.User,
          contentParts: [{ type: 'text', text: 'Question' }],
        },
        {
          id: 'assistant-1',
          role: MessageRoleEnum.Assistant,
          contentParts: [
            { type: 'reasoning', text: 'Must stay local' },
            { type: 'text', text: 'Answer' },
          ],
        },
        {
          id: 'user-2',
          role: MessageRoleEnum.User,
          contentParts: [{ type: 'text', text: 'Continue' }],
        },
      ]

      const prepared = await prepareAgentGenerationHarness({
        session: createSession(),
        settings: { provider: 'custom-openai', modelId } as SessionSettings,
        globalSettings: {} as Settings,
        configs: { uuid: 'config-1' } as Config,
        messages,
        targetMsgIx: messages.length,
        model: createMockModel({ modelId, apiStyle: 'openai' }),
        dependencies: createModelDependencies(),
        webBrowsing: false,
        agentModeValue: 'off',
        agentModeLocked: false,
        agentModeSupported: true,
        signal: new AbortController().signal,
      })

      const upstreamMessages = convertToOpenAICompatibleChatMessages(prepared.coreMessages)
      expect(upstreamMessages.find((message) => message.role === 'assistant')).toEqual({
        role: 'assistant',
        content: 'Answer',
      })
    }
  )
})

describe('session prompt context snapshot', () => {
  function createUserMessage(text = 'Help me with a task.'): Message {
    return {
      id: 'msg-user-1',
      role: MessageRoleEnum.User,
      timestamp: Date.now(),
      contentParts: [{ type: 'text', text }],
    }
  }

  function createSystemMessage(text: string): Message {
    return {
      id: 'msg-system-1',
      role: MessageRoleEnum.System,
      timestamp: Date.now(),
      contentParts: [{ type: 'text', text }],
    }
  }

  function prepareWith(settings: SessionSettings, messages: Message[], sideEffects = {}) {
    return prepareAgentGenerationHarness({
      session: createSession(),
      settings,
      globalSettings: {} as Settings,
      configs: { uuid: 'config-1' } as Config,
      messages,
      targetMsgIx: messages.length,
      model: createMockModel(),
      dependencies: createModelDependencies(),
      webBrowsing: false,
      agentModeValue: 'on',
      agentModeLocked: true,
      agentModeSupported: true,
      signal: new AbortController().signal,
      sandboxProviderFactory: () => sandboxProviderMock as unknown as SandboxProvider,
      isPro: () => true,
      sideEffects,
    })
  }

  test('captures and persists a snapshot, drops session system prompts, and pins the capture date', async () => {
    const persistSessionPromptContextSnapshot = vi.fn()
    const prepared = await prepareWith(
      { provider: ModelProviderEnum.ChatboxAI, modelId: 'test-model' } as SessionSettings,
      [createSystemMessage('You are a pirate copilot.'), createUserMessage()],
      { persistSessionPromptContextSnapshot }
    )

    expect(persistSessionPromptContextSnapshot).toHaveBeenCalledTimes(1)
    const snapshot = persistSessionPromptContextSnapshot.mock.calls[0][0]
    expect(snapshot.version).toBe(1)
    expect(snapshot.workspaceDirectories).toEqual([])

    const serialized = JSON.stringify(prepared.coreMessages)
    expect(serialized).toContain('You are Chatbox agent')
    expect(serialized).toContain('## Soul')
    // Untouched template falls back to the default persona.
    expect(serialized).toContain('Be genuinely helpful, not performatively helpful')
    expect(serialized).toContain('Session context captured:')
    // The legacy session system prompt is discarded in agent mode.
    expect(serialized).not.toContain('You are a pirate copilot.')
    // Memory tools are part of the agent tool set.
    expect(prepared.tools.save_memory).toBeDefined()
    expect(prepared.tools.delete_memory).toBeDefined()
  })

  test('reuses an existing snapshot verbatim without re-capturing', async () => {
    const persistSessionPromptContextSnapshot = vi.fn()
    const prepared = await prepareWith(
      {
        provider: ModelProviderEnum.ChatboxAI,
        modelId: 'test-model',
        sessionPromptContextSnapshot: {
          version: 1,
          soul: 'My frozen custom persona content.',
          memories: [{ id: 'm1', content: 'User prefers pnpm over npm', createdAt: 1700000000000 }],
          workspaceInstructions: '\n## Workspace Instructions\nFROZEN-WORKSPACE-MARKER\n',
          workspaceDirectories: [],
          capturedAt: 1700000000000,
        },
      } as SessionSettings,
      [createUserMessage()],
      { persistSessionPromptContextSnapshot }
    )

    expect(persistSessionPromptContextSnapshot).not.toHaveBeenCalled()
    const serialized = JSON.stringify(prepared.coreMessages)
    expect(serialized).toContain('My frozen custom persona content.')
    expect(serialized).toContain('[m1] User prefers pnpm over npm')
    expect(serialized).toContain('FROZEN-WORKSPACE-MARKER')
  })

  test('re-captures when the working directories change', async () => {
    const persistSessionPromptContextSnapshot = vi.fn()
    await prepareWith(
      {
        provider: ModelProviderEnum.ChatboxAI,
        modelId: 'test-model',
        workingDirectories: ['/new/dir'],
        sessionPromptContextSnapshot: {
          version: 1,
          soul: 'Stale soul.',
          memories: [],
          workspaceInstructions: '',
          workspaceDirectories: ['/old/dir'],
          capturedAt: 1700000000000,
        },
      } as SessionSettings,
      [createUserMessage()],
      { persistSessionPromptContextSnapshot }
    )

    expect(persistSessionPromptContextSnapshot).toHaveBeenCalledTimes(1)
    const snapshot = persistSessionPromptContextSnapshot.mock.calls[0][0]
    expect(snapshot.workspaceDirectories).toEqual(['/new/dir'])
  })

  test('re-captures when the existing snapshot was chat-scoped', async () => {
    const persistSessionPromptContextSnapshot = vi.fn()
    await prepareWith(
      {
        provider: ModelProviderEnum.ChatboxAI,
        modelId: 'test-model',
        sessionPromptContextSnapshot: {
          version: 1,
          soul: 'Chat-era soul that must not gate agent identity.',
          memories: [],
          workspaceInstructions: '',
          workspaceDirectories: [],
          capturedAt: 1700000000000,
          scope: 'chat',
        },
      } as SessionSettings,
      [createUserMessage()],
      { persistSessionPromptContextSnapshot }
    )

    expect(persistSessionPromptContextSnapshot).toHaveBeenCalledTimes(1)
    expect(persistSessionPromptContextSnapshot.mock.calls[0][0].scope).toBe('agent')
  })

  test('chat mode keeps the legacy system prompt path untouched', async () => {
    const prepared = await prepareAgentGenerationHarness({
      session: createSession(),
      settings: { provider: ModelProviderEnum.ChatboxAI, modelId: 'test-model' } as SessionSettings,
      globalSettings: {} as Settings,
      configs: { uuid: 'config-1' } as Config,
      messages: [createSystemMessage('You are a pirate copilot.'), createUserMessage()],
      targetMsgIx: 2,
      model: createMockModel(),
      dependencies: createModelDependencies(),
      webBrowsing: false,
      agentModeValue: 'off',
      agentModeLocked: false,
      agentModeSupported: true,
      signal: new AbortController().signal,
      sandboxProviderFactory: () => sandboxProviderMock as unknown as SandboxProvider,
      isPro: () => true,
    })

    const serialized = JSON.stringify(prepared.coreMessages)
    expect(serialized).toContain('You are a pirate copilot.')
    expect(serialized).not.toContain('You are Chatbox agent')
  })
})

describe('chat mode memories', () => {
  function chatPrepare(settings: SessionSettings, messages: Message[], sideEffects = {}) {
    return prepareAgentGenerationHarness({
      session: createSession(),
      settings,
      globalSettings: {} as Settings,
      configs: { uuid: 'config-1' } as Config,
      messages,
      targetMsgIx: messages.length,
      model: createMockModel(),
      dependencies: createModelDependencies(),
      webBrowsing: false,
      agentModeValue: 'off',
      agentModeLocked: false,
      agentModeSupported: true,
      signal: new AbortController().signal,
      sandboxProviderFactory: () => sandboxProviderMock as unknown as SandboxProvider,
      isPro: () => true,
      sideEffects,
    })
  }

  const userMessage: Message = {
    id: 'msg-user-1',
    role: MessageRoleEnum.User,
    timestamp: Date.now(),
    contentParts: [{ type: 'text', text: 'Hello there' }],
  }

  const systemMessage: Message = {
    id: 'msg-system-1',
    role: MessageRoleEnum.System,
    timestamp: Date.now(),
    contentParts: [{ type: 'text', text: 'You are a pirate copilot.' }],
  }

  test('injects snapshot memories read-only while keeping the session system prompt', async () => {
    const prepared = await chatPrepare(
      {
        provider: ModelProviderEnum.ChatboxAI,
        modelId: 'test-model',
        sessionPromptContextSnapshot: {
          version: 1,
          soul: 'Custom soul that must stay agent-only.',
          memories: [{ id: 'm1', content: 'User prefers pnpm over npm', createdAt: 1700000000000 }],
          workspaceInstructions: '',
          workspaceDirectories: [],
          capturedAt: 1700000000000,
        },
      } as SessionSettings,
      [systemMessage, userMessage]
    )

    const serialized = JSON.stringify(prepared.coreMessages)
    expect(serialized).toContain('You are a pirate copilot.')
    expect(serialized).toContain('[m1] User prefers pnpm over npm')
    // No Soul/identity leaks into chat mode.
    expect(serialized).not.toContain('You are Chatbox agent')
    expect(serialized).not.toContain('Custom soul that must stay agent-only.')
    // Memory tools are registered, so the guidance references them.
    expect(prepared.tools.save_memory).toBeDefined()
    expect(serialized).toContain('save_memory')
  })

  test('captures a memories snapshot on first chat generation when memories exist', async () => {
    const storage = (await import('@/storage')).default
    await storage.setItemNow('agent-memories', [{ id: 'm2', content: 'Timezone is UTC+8', createdAt: 1700000000000 }])
    const persistSessionPromptContextSnapshot = vi.fn()
    const prepared = await chatPrepare(
      { provider: ModelProviderEnum.ChatboxAI, modelId: 'test-model' } as SessionSettings,
      [userMessage],
      { persistSessionPromptContextSnapshot }
    )
    expect(persistSessionPromptContextSnapshot).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(prepared.coreMessages)).toContain('[m2] Timezone is UTC+8')
  })

  test('memory switch off removes tools and injection in both modes', async () => {
    // tools-builder reads the switch from the settings store; the harness reads
    // the same settings through the globalSettings parameter.
    getSettingsMock.mockReturnValue({
      skills: { enabledSkillNames: [] },
      memoryEnabled: false,
    })
    const prepared = await prepareAgentGenerationHarness({
      session: createSession(),
      settings: {
        provider: ModelProviderEnum.ChatboxAI,
        modelId: 'test-model',
        sessionPromptContextSnapshot: {
          version: 1,
          soul: 'Persisted soul.',
          memories: [{ id: 'm9', content: 'Should not appear', createdAt: 1700000000000 }],
          workspaceInstructions: '',
          workspaceDirectories: [],
          capturedAt: 1700000000000,
        },
      } as SessionSettings,
      globalSettings: { memoryEnabled: false } as Settings,
      configs: { uuid: 'config-1' } as Config,
      messages: [userMessage],
      targetMsgIx: 1,
      model: createMockModel(),
      dependencies: createModelDependencies(),
      webBrowsing: false,
      agentModeValue: 'on',
      agentModeLocked: true,
      agentModeSupported: true,
      signal: new AbortController().signal,
      sandboxProviderFactory: () => sandboxProviderMock as unknown as SandboxProvider,
      isPro: () => true,
    })

    expect(prepared.tools.save_memory).toBeUndefined()
    expect(prepared.tools.delete_memory).toBeUndefined()
    const serialized = JSON.stringify(prepared.coreMessages)
    expect(serialized).not.toContain('Should not appear')
    expect(serialized).not.toContain('## Memories')
    // Soul is independent of the memory switch.
    expect(serialized).toContain('Persisted soul.')
  })

  test('does not capture mid-conversation even when memories appear', async () => {
    const storage = (await import('@/storage')).default
    await storage.setItemNow('agent-memories', [
      { id: 'm3', content: 'Appeared mid-conversation', createdAt: 1700000000000 },
    ])
    const persistSessionPromptContextSnapshot = vi.fn()
    const assistantMessage: Message = {
      id: 'msg-assistant-1',
      role: MessageRoleEnum.Assistant,
      timestamp: Date.now(),
      contentParts: [{ type: 'text', text: 'Sure, done.' }],
    }
    const prepared = await chatPrepare(
      { provider: ModelProviderEnum.ChatboxAI, modelId: 'test-model' } as SessionSettings,
      [userMessage, assistantMessage, { ...userMessage, id: 'msg-user-2' }],
      { persistSessionPromptContextSnapshot }
    )
    expect(persistSessionPromptContextSnapshot).not.toHaveBeenCalled()
    expect(JSON.stringify(prepared.coreMessages)).not.toContain('Appeared mid-conversation')
    await storage.setItemNow('agent-memories', [])
  })

  test('skips snapshot capture entirely when no memories exist', async () => {
    const storage = (await import('@/storage')).default
    await storage.setItemNow('agent-memories', [])
    const persistSessionPromptContextSnapshot = vi.fn()
    const prepared = await chatPrepare(
      { provider: ModelProviderEnum.ChatboxAI, modelId: 'test-model' } as SessionSettings,
      [userMessage],
      { persistSessionPromptContextSnapshot }
    )
    expect(persistSessionPromptContextSnapshot).not.toHaveBeenCalled()
    expect(JSON.stringify(prepared.coreMessages)).not.toContain('## Memories')
  })
})
