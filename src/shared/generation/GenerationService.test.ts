import type { ChatStreamOptions, ModelInterface, ModelStreamPart } from '@shared/models/types'
import type { Config, Message, Session, SessionSettings, Settings } from '@shared/types'
import type { ModelMessage, ToolSet } from 'ai'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { generationStreamFixture } from './__fixtures__/generation-stream'
import { GenerationService, type GenerationServiceDependencies, type GenerationSessionPort } from './GenerationService'
import { GenerationRuntimeStore } from './runtime-store'

type ModelContext = { host: 'test' }

function targetMessage(): Message {
  return {
    id: 'assistant-1',
    role: 'assistant',
    generating: true,
    contentParts: [],
  }
}

function createSession(): Session {
  return {
    id: 'session-1',
    name: 'Session',
    type: 'chat',
    messages: [{ id: 'user-1', role: 'user', contentParts: [{ type: 'text', text: 'Hello' }] }, targetMessage()],
  }
}

async function* stream(chunks: ModelStreamPart<ToolSet>[], terminalError?: unknown) {
  await Promise.resolve()
  for (const chunk of chunks) {
    yield chunk
  }
  if (terminalError) throw terminalError
}

interface Harness {
  service: GenerationService<ModelContext>
  runtime: GenerationRuntimeStore
  persisted: Array<{ message: Message; refreshCounting: boolean }>
  cached: Message[]
  coordinationEvents: string[]
  session: Session
  globalSettings: Settings
  trackPauseAction: ReturnType<typeof vi.fn>
  afterMessageGenerated: ReturnType<typeof vi.fn>
  steeringInject: ReturnType<typeof vi.fn>
  steeringRegister: ReturnType<typeof vi.fn>
  steeringRelease: ReturnType<typeof vi.fn>
  steeringWake: ReturnType<typeof vi.fn>
  model: ModelInterface
  setStreamFactory(factory: () => AsyncGenerator<ModelStreamPart<ToolSet>>): void
  setChatStreamFactory(
    factory: (messages: ModelMessage[], options: ChatStreamOptions) => AsyncGenerator<ModelStreamPart<ToolSet>>
  ): void
  setPrepareStep(prepareStep: ChatStreamOptions['prepareStep']): void
  setTools(tools: ToolSet): void
  failSessionSettingsUpdate(error: Error): void
  failPersistenceFromCall(call: number, error: Error): void
  enableAgentModeSuggestion(result: Message['contentParts']): void
  setNow(value: number): void
}

function createHarness(): Harness {
  const session = createSession()
  const sessionSettings = {
    provider: 'openai',
    modelId: 'test-model',
  } satisfies SessionSettings
  const globalSettings = {} as Settings
  const persisted: Harness['persisted'] = []
  const cached: Message[] = []
  const coordinationEvents: string[] = []
  const runtime = new GenerationRuntimeStore()
  let now = 1_000
  let streamFactory = () => stream([])
  let chatStreamFactory = (_messages: ModelMessage[], _options: ChatStreamOptions) => streamFactory()
  let prepareStep: ChatStreamOptions['prepareStep']
  let pausedTools: ToolSet = {}
  let agentModeSuggestionEnabled = false
  let suggestionResult: Message['contentParts'] = []
  let sessionSettingsUpdateError: Error | undefined
  let persistenceFailure: { call: number; error: Error } | undefined
  let persistenceCallCount = 0
  const trackPauseAction = vi.fn()
  const afterMessageGenerated = vi.fn()
  const steeringInject = vi.fn((_messages: ModelMessage[]) => Promise.resolve(undefined as ModelMessage[] | undefined))
  const steeringRelease = vi.fn()
  const steeringRegister = vi.fn(() => ({ inject: steeringInject, release: steeringRelease }))
  const steeringWake = vi.fn()

  const model = {
    name: 'Test',
    modelId: 'test-model',
    isSupportVision: () => true,
    isSupportToolUse: (scope?: Parameters<ModelInterface['isSupportToolUse']>[0]) =>
      scope === 'agent' && agentModeSuggestionEnabled,
    isSupportSystemMessage: () => true,
    normalizeCompletedResponse: (parts: Message['contentParts']) => parts,
    chat: () => Promise.resolve({ contentParts: suggestionResult }),
    chatStream: (messages: ModelMessage[], options: ChatStreamOptions) => chatStreamFactory(messages, options),
  } as unknown as ModelInterface

  const sessions: GenerationSessionPort = {
    getSession: () => Promise.resolve(session),
    isSessionMissingError: (error) => error === persistenceFailure?.error,
    getSessionSettings: () => Promise.resolve(sessionSettings),
    updateSessionSettings: (_sessionId, update) => {
      if (sessionSettingsUpdateError) return Promise.reject(sessionSettingsUpdateError)
      session.settings = update(session.settings)
      return Promise.resolve()
    },
    initializeTargetMessage: (message) =>
      Promise.resolve({
        ...message,
        generating: true,
        status: [],
      }),
    persistStreamingMessage: (_sessionId, message, options) => {
      persistenceCallCount += 1
      if (persistenceFailure && persistenceCallCount >= persistenceFailure.call) {
        return Promise.reject(persistenceFailure.error)
      }
      const index = session.messages.findIndex((candidate) => candidate.id === message.id)
      if (index >= 0) {
        session.messages[index] = message
      }
      persisted.push({
        message: { ...message, contentParts: [...message.contentParts] },
        refreshCounting: options?.refreshCounting === true,
      })
      return Promise.resolve()
    },
    updateStreamingCache: (_sessionId, message) => {
      cached.push({ ...message, contentParts: [...message.contentParts] })
    },
    findTargetMessageIndex: (current, messageId) => {
      const index = current.messages.findIndex((message) => message.id === messageId)
      return index < 0 ? null : { messages: current.messages, index }
    },
    getCompactionPointsForTarget: (current) => current.compactionPoints,
    findMessage: (current, messageId) => current.messages.find((message) => message.id === messageId),
    modifyMessage: (_sessionId, message) => {
      const index = session.messages.findIndex((candidate) => candidate.id === message.id)
      if (index >= 0) {
        session.messages[index] = message
      }
      persisted.push({
        message: { ...message, contentParts: [...message.contentParts] },
        refreshCounting: true,
      })
      return Promise.resolve()
    },
    handleGenerationError: (error, message) => ({
      ...message,
      generating: false,
      cancel: undefined,
      status: [],
      error: error instanceof Error ? error.message : String(error),
      errorExtra: { source: 'test-error-mapper' },
    }),
  }

  const dependencies: GenerationServiceDependencies<ModelContext> = {
    sessions,
    settings: {
      getSettings: () => globalSettings,
      updateSettings: (update) => {
        Object.assign(globalSettings, typeof update === 'function' ? update(globalSettings) : update)
      },
    },
    models: {
      createModel: () => Promise.resolve(model),
      createContext: () => Promise.resolve({ model, context: { host: 'test' } }),
      createWithContext: () => Promise.resolve(model),
    },
    preparation: {
      prepare: (request) =>
        Promise.resolve({
          promptMessages: request.messages.slice(0, request.targetMessageIndex),
          coreMessages: [],
          tools: {},
          chatOptions: { signal: request.signal, prepareStep },
          infoParts: [],
          fallbackToolCallPart: undefined,
        }),
    },
    tools: {
      buildToolsForPausedToolCall: () => Promise.resolve(pausedTools),
    },
    coordination: {
      runExclusive: (sessionId, operation) => {
        coordinationEvents.push(`lock:${sessionId}`)
        return operation()
      },
      wakeBackgroundTaskFollowUps: (sessionId) => {
        coordinationEvents.push(`wake:${sessionId}`)
      },
    },
    steering: {
      register: steeringRegister,
      wake: steeringWake,
    },
    runtime,
    blobs: {
      set: () => Promise.resolve(),
    },
    attachments: {
      read: () => Promise.resolve(null),
    },
    capabilities: {
      supports: (capability) => capability === 'agent-mode' && agentModeSuggestionEnabled,
    },
    host: {
      getConfig: () => Promise.resolve({} as Config),
      getKnowledgeBase: () => undefined,
      getWebBrowsing: () => false,
      getAgentModeEntry: () => ({ value: agentModeSuggestionEnabled ? 'auto' : 'off' }),
      setAgentMode: () => undefined,
      lockAgentMode: () => undefined,
      createPictureStorageKey: (sessionId, messageId) => `picture:${sessionId}:${messageId}`,
      estimateTokens: () => 42,
      markFirstSuccessfulChatCompleted: vi.fn(),
      afterMessageGenerated,
      now: () => now,
    },
    analytics: {
      init: vi.fn(),
      event: vi.fn(),
      trackGenerate: vi.fn(),
      trackSuggestionDecision: vi.fn(),
      trackAgentModeSuggested: vi.fn(),
      trackPauseAction,
      captureException: vi.fn(),
    },
    logger: {
      log: vi.fn(),
    },
  }

  return {
    service: new GenerationService(dependencies),
    runtime,
    persisted,
    cached,
    coordinationEvents,
    session,
    globalSettings,
    trackPauseAction,
    afterMessageGenerated,
    steeringInject,
    steeringRegister,
    steeringRelease,
    steeringWake,
    model,
    setStreamFactory(factory) {
      streamFactory = factory
    },
    setChatStreamFactory(factory) {
      chatStreamFactory = factory
    },
    setPrepareStep(nextPrepareStep) {
      prepareStep = nextPrepareStep
    },
    setTools(tools) {
      pausedTools = tools
    },
    failSessionSettingsUpdate(error) {
      sessionSettingsUpdateError = error
    },
    failPersistenceFromCall(call, error) {
      persistenceFailure = { call, error }
    },
    enableAgentModeSuggestion(result) {
      agentModeSuggestionEnabled = true
      suggestionResult = result
    },
    setNow(value) {
      now = value
    },
  }
}

function lastPersisted(harness: Harness): Message {
  const entry = harness.persisted.at(-1)
  if (!entry) throw new Error('Expected a persisted message')
  return entry.message
}

describe('GenerationService', () => {
  let harness: Harness

  beforeEach(() => {
    harness = createHarness()
  })

  it('replays the shared stream fixture and persists the current terminal projection', async () => {
    harness.setStreamFactory(() => stream(generationStreamFixture.chunks))

    await harness.service.orchestrate('session-1', targetMessage(), { operationType: 'send_message' })

    const finalMessage = lastPersisted(harness)
    const portableParts = finalMessage.contentParts.map((part) => {
      if (part.type !== 'tool-call') return part
      const { duration: _duration, startTime: _startTime, ...portablePart } = part
      return portablePart
    })
    expect(portableParts).toEqual(generationStreamFixture.expectedContentParts)
    expect(finalMessage).toMatchObject({
      generating: false,
      status: [],
      finishReason: generationStreamFixture.expectedFinishReason,
      usage: generationStreamFixture.expectedUsage,
      tokensUsed: 42,
    })
    expect(finalMessage.cancel).toBeUndefined()
    expect(harness.persisted.filter(({ refreshCounting }) => refreshCounting)).toHaveLength(1)
    expect(harness.runtime.get('session-1')).toBeUndefined()
    expect(harness.afterMessageGenerated).toHaveBeenCalledWith('session-1', finalMessage)
  })

  it('consumes a stop requested before runtime registration without starting the provider stream', async () => {
    harness.runtime.requestAbort('session-1', 'assistant-1', 900)
    harness.setChatStreamFactory(() => {
      throw new Error('provider stream must not start')
    })

    await harness.service.orchestrate('session-1', targetMessage(), { operationType: 'send_message' })

    expect(lastPersisted(harness)).toMatchObject({
      id: 'assistant-1',
      generating: false,
      finishReason: 'canceled',
    })
    expect(harness.runtime.get('session-1')).toBeUndefined()
  })

  it('registers preparing runtime before the first setup await and stops without starting the provider stream', async () => {
    harness.setChatStreamFactory(() => {
      throw new Error('provider stream must not start')
    })

    const generation = harness.service.orchestrate('session-1', targetMessage(), { operationType: 'send_message' })

    expect(harness.runtime.get('session-1', 'assistant-1')?.phase).toBe('preparing')
    harness.runtime.requestAbort('session-1', 'assistant-1', 900)
    await generation

    expect(lastPersisted(harness)).toMatchObject({
      id: 'assistant-1',
      generating: false,
      finishReason: 'canceled',
    })
    expect(harness.afterMessageGenerated).not.toHaveBeenCalled()
    expect(harness.runtime.get('session-1')).toBeUndefined()
  })

  it('wires steering into prepareStep and releases it when generation settles', async () => {
    const basePrepareStep = vi.fn(() => Promise.resolve({ activeTools: ['tool_a'] }))
    harness.setPrepareStep(basePrepareStep)
    harness.steeringInject
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce([{ role: 'user', content: 'steered' }])

    const stepResults: unknown[] = []
    harness.setChatStreamFactory((_messages, options) =>
      (async function* streamWithSteering() {
        const prepareStep = options.prepareStep
        if (!prepareStep) throw new Error('Expected prepareStep to be wired')
        const prepareOptions = {
          steps: [],
          stepNumber: 0,
          model: {},
          messages: [{ role: 'user', content: 'Hello' }] as ModelMessage[],
          experimental_context: undefined,
        } as unknown as Parameters<NonNullable<ChatStreamOptions['prepareStep']>>[0]
        stepResults.push(await prepareStep(prepareOptions))
        stepResults.push(await prepareStep(prepareOptions))
        yield { type: 'finish', finishReason: 'stop' } as ModelStreamPart<ToolSet>
      })()
    )

    await harness.service.orchestrate('session-1', targetMessage())

    // Steered messages anchor after the target assistant message: the send
    // order in the conversation follows the reply the user interjected below.
    expect(harness.steeringRegister).toHaveBeenCalledWith(
      'session-1',
      'assistant-1',
      new Set(['user-1', 'assistant-1'])
    )
    expect(stepResults).toEqual([
      { activeTools: ['tool_a'] },
      { activeTools: ['tool_a'], messages: [{ role: 'user', content: 'steered' }] },
    ])
    expect(harness.steeringRelease).toHaveBeenCalledOnce()
    expect(harness.steeringWake).toHaveBeenCalledWith('session-1')
  })

  it('applies steering after an inner prepareStep message rewrite', async () => {
    const rewrittenMessages = [{ role: 'user', content: 'with injected image' }] as ModelMessage[]
    harness.setPrepareStep(() => Promise.resolve({ activeTools: ['tool_a'], messages: rewrittenMessages }))
    harness.steeringInject.mockImplementationOnce((messages: ModelMessage[]) =>
      Promise.resolve([...messages, { role: 'user', content: 'steered' }])
    )

    let stepResult: unknown
    harness.setChatStreamFactory((_messages, options) =>
      (async function* streamWithComposedPrepareStep() {
        const prepareStep = options.prepareStep
        if (!prepareStep) throw new Error('Expected prepareStep to be wired')
        stepResult = await prepareStep({
          steps: [],
          stepNumber: 0,
          model: {},
          messages: [{ role: 'user', content: 'original' }],
          experimental_context: undefined,
        } as unknown as Parameters<NonNullable<ChatStreamOptions['prepareStep']>>[0])
        yield { type: 'finish', finishReason: 'stop' } as ModelStreamPart<ToolSet>
      })()
    )

    await harness.service.orchestrate('session-1', targetMessage())

    expect(harness.steeringInject).toHaveBeenCalledWith(rewrittenMessages)
    expect(stepResult).toEqual({
      activeTools: ['tool_a'],
      messages: [
        { role: 'user', content: 'with injected image' },
        { role: 'user', content: 'steered' },
      ],
    })
  })

  it('persists a tool-call checkpoint immediately instead of waiting for the periodic interval', async () => {
    harness.setStreamFactory(() =>
      stream([
        { type: 'text-delta', text: 'before' } as ModelStreamPart<ToolSet>,
        {
          type: 'tool-call',
          toolCallId: 'tool-1',
          toolName: 'search',
          input: { query: 'Chatbox' },
        } as ModelStreamPart<ToolSet>,
      ])
    )

    await harness.service.orchestrate('session-1', targetMessage())

    expect(harness.persisted).toHaveLength(3)
    expect(harness.persisted[1].refreshCounting).toBe(false)
    expect(harness.persisted[1].message.contentParts).toEqual([
      { type: 'text', text: 'before' },
      expect.objectContaining({ type: 'tool-call', toolCallId: 'tool-1' }),
    ])
  })

  it('ends the first user turn with the existing Agent Mode suggestion projection', async () => {
    harness.enableAgentModeSuggestion([
      {
        type: 'text',
        text: '{"suggest":true,"reason":"This task needs files and tools"}',
      },
    ])

    await harness.service.orchestrate('session-1', targetMessage(), { operationType: 'send_message' })

    expect(lastPersisted(harness)).toMatchObject({
      generating: false,
      finishReason: 'agent-mode-suggested',
      status: [],
      contentParts: [
        {
          type: 'agent-mode-suggestion',
          reason: 'This task needs files and tools',
        },
      ],
    })
    expect(harness.runtime.get('session-1')).toBeUndefined()
  })

  it('uses the runtime cancel projection and persists abort as a non-error terminal state', async () => {
    harness.setStreamFactory(() =>
      (async function* abortedStream() {
        await Promise.resolve()
        const cachedMessage = harness.cached.at(-1)
        cachedMessage?.cancel?.()
        expect(harness.runtime.get('session-1')?.abortController.signal.aborted).toBe(true)
        yield* []
        throw new Error('request aborted')
      })()
    )

    await harness.service.orchestrate('session-1', targetMessage())

    expect(lastPersisted(harness)).toMatchObject({
      generating: false,
      status: [],
    })
    expect(lastPersisted(harness).error).toBeUndefined()
    expect(harness.runtime.get('session-1')).toBeUndefined()
  })

  it('releases the runtime when an external abort interrupts the stream drain barrier', async () => {
    let releaseDrain: () => void = () => undefined
    const drain = new Promise<void>((resolve) => {
      releaseDrain = resolve
    })
    harness.runtime.registerUnsettledStreamDrain('session-1', drain)
    const externalAbortController = new AbortController()

    const generation = harness.service.orchestrate('session-1', targetMessage(), {
      externalAbortSignal: externalAbortController.signal,
    })
    await vi.waitFor(() => expect(harness.cached.at(-1)?.cancel).toEqual(expect.any(Function)))

    externalAbortController.abort()
    await generation

    expect(lastPersisted(harness)).toMatchObject({
      generating: false,
      status: [],
      finishReason: 'canceled',
    })
    expect(harness.runtime.get('session-1')).toBeUndefined()

    releaseDrain()
    await drain
  })

  it('maps ordinary errors through the injected host error policy', async () => {
    harness.setStreamFactory(() => stream([], new Error('provider failed')))

    await harness.service.orchestrate('session-1', targetMessage())

    expect(lastPersisted(harness)).toMatchObject({
      generating: false,
      status: [],
      error: 'provider failed',
      errorExtra: { source: 'test-error-mapper' },
    })
    expect(harness.runtime.get('session-1')).toBeUndefined()
  })

  it('treats a disappearing session as an expected terminal outcome', async () => {
    const missingSession = new Error('Session session-1 not found')
    harness.failPersistenceFromCall(2, missingSession)
    harness.setStreamFactory(() =>
      (async function* disappearingSessionStream() {
        await Promise.resolve()
        harness.setNow(3_000)
        yield { type: 'text-delta', text: 'partial' } as ModelStreamPart<ToolSet>
      })()
    )

    await expect(harness.service.orchestrate('session-1', targetMessage())).resolves.toBeUndefined()
    expect(harness.runtime.get('session-1')).toBeUndefined()
    expect(lastPersisted(harness).error).toBeUndefined()
  })

  it('retains paused runtime state and a structured tool approval reason', async () => {
    harness.setStreamFactory(() =>
      stream(
        [
          {
            type: 'tool-call',
            toolCallId: 'tool-1',
            toolName: 'user_exec',
            input: { command: 'pwd' },
          } as ModelStreamPart<ToolSet>,
        ],
        {
          name: 'UserExecApprovalPausedError',
          toolCallId: 'tool-1',
          command: 'pwd',
          explanation: 'Inspect the current directory',
        }
      )
    )

    await harness.service.orchestrate('session-1', targetMessage())

    expect(lastPersisted(harness)).toMatchObject({
      generating: false,
      finishReason: 'tool-call-paused',
      status: [],
      contentParts: [
        {
          type: 'tool-call',
          state: 'paused',
          toolCallId: 'tool-1',
          pauseReason: {
            type: 'user_exec_approval',
            command: 'pwd',
            explanation: 'Inspect the current directory',
          },
        },
      ],
    })
    expect(harness.runtime.get('session-1')).toMatchObject({
      messageId: 'assistant-1',
      phase: 'paused',
    })
  })

  it('uses host time for the periodic checkpoint boundary', async () => {
    harness.setStreamFactory(() =>
      (async function* timedStream() {
        await Promise.resolve()
        yield { type: 'text-delta', text: 'first' } as ModelStreamPart<ToolSet>
        harness.setNow(3_000)
        yield { type: 'text-delta', text: ' second' } as ModelStreamPart<ToolSet>
      })()
    )

    await harness.service.orchestrate('session-1', targetMessage())

    expect(harness.persisted).toHaveLength(3)
    expect(harness.persisted[1].message.contentParts).toEqual([{ type: 'text', text: 'first second' }])
  })

  it('owns locking and background follow-up wake-up for paused-tool entry points', async () => {
    await harness.service.stopPausedToolCall('session-1', 'assistant-1', 'missing-tool')
    await harness.service.continuePausedToolCall('session-1', 'assistant-1', 'missing-tool')
    await harness.service.retryFromLastToolCallAfterApiError('session-1', 'assistant-1', 'missing-tool')

    expect(harness.coordinationEvents).toEqual([
      'lock:session-1',
      'wake:session-1',
      'lock:session-1',
      'wake:session-1',
      'lock:session-1',
    ])
  })

  it('persists a session tool-limit opt-out without changing the global setting', async () => {
    harness.session.settings = { provider: 'openai', temperature: 0.3 }
    harness.globalSettings.pauseOnToolCallLimit = true

    await harness.service.disableToolCallLimitPauseAndContinue('session-1', 'assistant-1', 'missing-tool', 'session')

    expect(harness.session.settings).toEqual({
      provider: 'openai',
      temperature: 0.3,
      pauseOnToolCallLimit: false,
    })
    expect(harness.globalSettings.pauseOnToolCallLimit).toBe(true)
  })

  it('persists a global tool-limit opt-out and removes the current session override', async () => {
    harness.session.settings = { provider: 'openai', temperature: 0.3, pauseOnToolCallLimit: true }
    harness.globalSettings.pauseOnToolCallLimit = true

    await harness.service.disableToolCallLimitPauseAndContinue('session-1', 'assistant-1', 'missing-tool', 'global')

    expect(harness.globalSettings.pauseOnToolCallLimit).toBe(false)
    expect(harness.session.settings).toEqual({ provider: 'openai', temperature: 0.3 })
  })

  it('tracks one opt-out action and resumes under the generation lock', async () => {
    await harness.service.disableToolCallLimitPauseAndContinue('session-1', 'assistant-1', 'missing-tool', 'session')

    expect(harness.trackPauseAction).toHaveBeenCalledOnce()
    expect(harness.trackPauseAction).toHaveBeenCalledWith({ type: 'tool_limit', action: 'disable_session' })
    await vi.waitFor(() => {
      expect(harness.coordinationEvents).toEqual(['lock:session-1', 'wake:session-1'])
    })
  })

  it('still resumes the paused batch when persisting the opt-out fails', async () => {
    harness.failSessionSettingsUpdate(new Error('storage failed'))

    await expect(
      harness.service.disableToolCallLimitPauseAndContinue('session-1', 'assistant-1', 'missing-tool', 'session')
    ).rejects.toThrow('storage failed')

    await vi.waitFor(() => {
      expect(harness.coordinationEvents).toEqual(['lock:session-1', 'wake:session-1'])
    })
  })

  it('continues an approved tool call, persists its result, and resumes generation', async () => {
    const execute = vi.fn(() => Promise.resolve({ stdout: '/workspace' }))
    harness.setTools({
      user_exec: {
        execute,
      },
    } as unknown as ToolSet)
    harness.session.messages[1] = {
      ...targetMessage(),
      generating: false,
      finishReason: 'tool-call-paused',
      contentParts: [
        {
          type: 'tool-call',
          state: 'paused',
          toolCallId: 'tool-1',
          toolName: 'user_exec',
          args: { command: 'pwd' },
          pauseReason: { type: 'user_exec_approval', command: 'pwd' },
        },
      ],
    }
    harness.runtime.start('session-1', 'assistant-1')
    harness.runtime.setPhase('session-1', 'assistant-1', 'paused')

    await harness.service.continuePausedToolCall('session-1', 'assistant-1', 'tool-1')

    expect(execute).toHaveBeenCalledWith(
      { command: 'pwd' },
      expect.objectContaining({
        toolCallId: 'tool-1',
        approved: true,
        approvalDetails: undefined,
        abortSignal: expect.any(AbortSignal),
      })
    )
    expect(lastPersisted(harness).contentParts).toEqual([
      expect.objectContaining({
        type: 'tool-call',
        state: 'result',
        toolCallId: 'tool-1',
        result: { stdout: '/workspace' },
        pauseReason: undefined,
      }),
    ])
    expect(harness.runtime.get('session-1')).toBeUndefined()
  })

  it('stops every call in a tool-limit batch without resuming generation', async () => {
    const pauseReason = { type: 'tool_call_limit' as const, maxToolCalls: 25 }
    harness.session.messages[1] = {
      ...targetMessage(),
      generating: false,
      finishReason: 'tool-call-paused',
      contentParts: [
        {
          type: 'tool-call',
          state: 'paused',
          toolCallId: 'tool-1',
          toolName: 'search',
          args: {},
          pauseReason,
        },
        {
          type: 'tool-call',
          state: 'paused',
          toolCallId: 'tool-2',
          toolName: 'search',
          args: {},
          pauseReason,
        },
      ],
    }
    harness.runtime.start('session-1', 'assistant-1')
    harness.runtime.setPhase('session-1', 'assistant-1', 'paused')

    await harness.service.stopPausedToolCall('session-1', 'assistant-1', 'tool-1')

    expect(lastPersisted(harness).contentParts).toEqual([
      expect.objectContaining({ toolCallId: 'tool-1', state: 'error', pauseReason: undefined }),
      expect.objectContaining({ toolCallId: 'tool-2', state: 'error', pauseReason: undefined }),
    ])
    expect(harness.runtime.get('session-1')).toBeUndefined()
  })

  it('retries the last interrupted tool call before resuming generation', async () => {
    const execute = vi.fn(() => Promise.resolve({ found: true }))
    harness.setTools({
      search: {
        execute,
      },
    } as unknown as ToolSet)
    harness.session.messages[1] = {
      ...targetMessage(),
      generating: false,
      error: 'provider disconnected',
      contentParts: [
        {
          type: 'tool-call',
          state: 'call',
          toolCallId: 'tool-1',
          toolName: 'search',
          args: { query: 'Chatbox' },
        },
      ],
    }

    await harness.service.retryFromLastToolCallAfterApiError('session-1', 'assistant-1', 'tool-1')

    expect(execute).toHaveBeenCalledWith(
      { query: 'Chatbox' },
      { toolCallId: 'tool-1', approved: true, approvalDetails: undefined }
    )
    expect(lastPersisted(harness)).toMatchObject({
      generating: false,
      error: undefined,
      contentParts: [
        expect.objectContaining({
          toolCallId: 'tool-1',
          state: 'result',
          result: { found: true },
        }),
      ],
    })
  })
})
