import type { ChatStreamOptions, ModelInterface, ModelStreamPart } from '@shared/models/types'
import type { Config, Message, Session, SessionSettings, Settings } from '@shared/types'
import { jsonSchema, type ModelMessage, type ToolSet } from 'ai'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { generationStreamFixture } from '../testing/generation-stream'
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

async function sha256Messages(messages: ModelMessage[]): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(messages)))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

interface Harness {
  service: GenerationService<ModelContext>
  runtime: GenerationRuntimeStore
  persisted: Array<{ message: Message; refreshCounting: boolean }>
  cached: Message[]
  coordinationEvents: string[]
  storedBlobs: Map<string, string>
  storeBlob: ReturnType<typeof vi.fn>
  touchBlob: ReturnType<typeof vi.fn>
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
  setPreparedTools(tools: ToolSet): void
  setSteeredMessageIds(messageIds: string[]): void
  setTools(tools: ToolSet): void
  failSessionSettingsUpdate(error: Error): void
  failPersistenceFromCall(call: number, error: Error): void
  failPersistenceOnCall(call: number, error: Error): void
  runOnPersistenceCall(call: number, action: () => void): void
  runBeforeProviderDispatch(action: () => void): void
  enableAgentModeSuggestion(result: Message['contentParts']): void
  setNow(value: number): void
}

function createHarness(): Harness {
  const session = createSession()
  const sessionSettings = {
    provider: 'openai',
    modelId: 'test-model',
    stream: false,
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
  let preparedTools: ToolSet = {}
  let pausedTools: ToolSet = {}
  const storedBlobs = new Map<string, string>()
  const storeBlob = vi.fn((storageKey: string, value: string) => {
    storedBlobs.set(storageKey, value)
    return Promise.resolve()
  })
  const touchBlob = vi.fn()
  let agentModeSuggestionEnabled = false
  let suggestionResult: Message['contentParts'] = []
  let sessionSettingsUpdateError: Error | undefined
  let persistenceFailure: { call: number; error: Error; exact?: boolean; missing?: boolean } | undefined
  let persistenceAction: { call: number; action: () => void } | undefined
  let beforeProviderDispatch: (() => void) | undefined
  let persistenceCallCount = 0
  const trackPauseAction = vi.fn()
  const afterMessageGenerated = vi.fn()
  const steeringInject = vi.fn((_messages: ModelMessage[]) => Promise.resolve(undefined as ModelMessage[] | undefined))
  let steeredMessageIds: string[] = []
  const steeringRelease = vi.fn()
  const steeringRegister = vi.fn(() => ({
    inject: steeringInject,
    getInjectedMessageIds: () => steeredMessageIds,
    release: steeringRelease,
  }))
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
    chatStream: async function* (messages: ModelMessage[], options: ChatStreamOptions) {
      const preparedStep = await options.prepareStep?.({
        steps: [],
        stepNumber: 0,
        model: {} as never,
        messages,
        experimental_context: undefined,
      })
      const activeToolNames = preparedStep?.activeTools ? new Set(preparedStep.activeTools.map(String)) : undefined
      const effectiveTools = activeToolNames
        ? Object.fromEntries(Object.entries(options.tools ?? {}).filter(([name]) => activeToolNames.has(name)))
        : (options.tools ?? {})
      await options.onRequestResolved?.({
        callSettings: {
          temperature: 0.25,
          maxOutputTokens: 8_192,
          providerOptions: { anthropic: { thinking: { type: 'enabled', budgetTokens: 1_024 } } },
        },
        modelMessages: preparedStep?.messages ?? messages,
        tools: effectiveTools,
        stream: true,
      })
      beforeProviderDispatch?.()
      if (options.signal?.aborted) return
      let firstPreparedStepPending = options.prepareStep !== undefined
      const streamOptions: ChatStreamOptions = firstPreparedStepPending
        ? {
            ...options,
            prepareStep: (stepOptions) => {
              if (firstPreparedStepPending && stepOptions.stepNumber === 0) {
                firstPreparedStepPending = false
                return preparedStep
              }
              return options.prepareStep?.(stepOptions)
            },
          }
        : options
      const providerStream = chatStreamFactory(messages, streamOptions)
      const providerIterator = providerStream[Symbol.asyncIterator]()
      let current = await providerIterator.next()
      while (!current.done) {
        const next = providerIterator.next()
        yield current.value
        current = await next
      }
    },
  } as unknown as ModelInterface

  const sessions: GenerationSessionPort = {
    getSession: () => Promise.resolve(session),
    isSessionMissingError: (error) => persistenceFailure?.missing === true && error === persistenceFailure.error,
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
      if (
        persistenceFailure &&
        (persistenceFailure.exact
          ? persistenceCallCount === persistenceFailure.call
          : persistenceCallCount >= persistenceFailure.call)
      ) {
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
      if (persistenceAction?.call === persistenceCallCount) persistenceAction.action()
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
          coreMessages: [{ role: 'user', content: 'Hello' }],
          tools: preparedTools,
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
      get: (storageKey) => Promise.resolve(storedBlobs.get(storageKey) ?? null),
      set: storeBlob,
      touch: touchBlob,
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
    storedBlobs,
    storeBlob,
    touchBlob,
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
    setPreparedTools(tools) {
      preparedTools = tools
    },
    setSteeredMessageIds(messageIds) {
      steeredMessageIds = messageIds
    },
    setTools(tools) {
      pausedTools = tools
    },
    failSessionSettingsUpdate(error) {
      sessionSettingsUpdateError = error
    },
    failPersistenceFromCall(call, error) {
      persistenceFailure = { call, error, missing: true }
    },
    failPersistenceOnCall(call, error) {
      persistenceFailure = { call, error, exact: true }
    },
    runOnPersistenceCall(call, action) {
      persistenceAction = { call, action }
    },
    runBeforeProviderDispatch(action) {
      beforeProviderDispatch = action
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
    expect(harness.persisted.filter(({ refreshCounting }) => refreshCounting)).toHaveLength(1)
    expect(harness.runtime.get('session-1')).toBeUndefined()
    expect(harness.afterMessageGenerated).toHaveBeenCalledWith('session-1', finalMessage)
  })

  it('persists the request snapshot before starting the provider stream', async () => {
    harness.setChatStreamFactory(() => {
      expect(harness.persisted.at(-1)?.message.generationRequests?.[0]).toMatchObject({
        version: 1,
        model: { provider: 'openai', id: 'test-model' },
        providerOptions: { anthropic: { thinking: { type: 'enabled', budgetTokens: 1_024 } } },
        callSettings: { temperature: 0.25, maxOutputTokens: 8_192, stream: true },
        context: {
          sessionBoundary: { messageCount: 1, firstMessageId: 'user-1', lastMessageId: 'user-1' },
          modelMessageCount: 1,
        },
        definitions: {
          storageKey: expect.stringMatching(/^generation-request:[a-f0-9]{64}$/),
          sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
      })
      return stream([])
    })

    await harness.service.orchestrate('session-1', targetMessage())

    const snapshot = harness.persisted[1].message.generationRequests?.[0]
    expect(snapshot?.context.sha256).toMatch(/^[a-f0-9]{64}$/)
    expect(JSON.parse(harness.storedBlobs.get(snapshot?.definitions.storageKey ?? '') ?? '')).toEqual({
      version: 1,
      tools: [],
    })
  })

  it('snapshots first-step message and active-tool overrides', async () => {
    harness.setPreparedTools({
      tool_a: { inputSchema: jsonSchema({ type: 'object' }) },
      tool_b: { inputSchema: jsonSchema({ type: 'object' }) },
    })
    const preparedMessages: ModelMessage[] = [{ role: 'user', content: 'original' }]
    const effectiveMessages: ModelMessage[] = [...preparedMessages, { role: 'user', content: 'steered' }]
    harness.setPrepareStep(() => ({ messages: preparedMessages, activeTools: ['tool_b'] }))
    harness.steeringInject.mockResolvedValueOnce(effectiveMessages)
    harness.setSteeredMessageIds(['steered-1'])

    await harness.service.orchestrate('session-1', targetMessage())

    const snapshot = harness.persisted[1].message.generationRequests?.[0]
    expect(snapshot?.context.sha256).toBe(await sha256Messages(effectiveMessages))
    expect(snapshot?.context.appendedMessageIds).toEqual(['steered-1'])
    const definitions = JSON.parse(harness.storedBlobs.get(snapshot?.definitions.storageKey ?? '') ?? '')
    expect(definitions.tools).toEqual([expect.objectContaining({ name: 'tool_b' })])
  })

  it('reuses an existing content-addressed definition blob', async () => {
    await harness.service.orchestrate('session-1', targetMessage())
    await harness.service.orchestrate('session-1', targetMessage())

    expect(harness.storeBlob).toHaveBeenCalledOnce()
    expect(harness.touchBlob).toHaveBeenCalledOnce()
    expect(harness.storedBlobs).toHaveLength(1)
  })

  it('overwrites a mismatched definition blob instead of failing the generation', async () => {
    await harness.service.orchestrate('session-1', targetMessage())
    const storageKey = [...harness.storedBlobs.keys()][0]
    const original = harness.storedBlobs.get(storageKey)
    harness.storedBlobs.set(storageKey, 'corrupted')

    await harness.service.orchestrate('session-1', targetMessage())

    expect(lastPersisted(harness).error).toBeUndefined()
    expect(harness.storedBlobs.get(storageKey)).toBe(original)
  })

  it('appends a request snapshot when continuing an existing assistant message', async () => {
    await harness.service.orchestrate('session-1', targetMessage())
    const firstDispatch = lastPersisted(harness)
    harness.setNow(2_000)

    await harness.service.orchestrate(
      'session-1',
      { ...firstDispatch, generating: true },
      { operationType: 'regenerate', appendToMessage: true }
    )

    expect(lastPersisted(harness).generationRequests?.map(({ capturedAt }) => capturedAt)).toEqual([1_000, 2_000])
  })

  it('records a snapshot for every provider step before its dispatch', async () => {
    const secondStepMessages: ModelMessage[] = [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Tool result is now available' },
    ]
    const snapshotsAtSecondDispatch = vi.fn()
    harness.setChatStreamFactory((_messages, options) =>
      (async function* twoStepStream() {
        yield { type: 'text-delta', text: 'First step output' } as ModelStreamPart<ToolSet>
        harness.setNow(4_000)
        await options.onRequestResolved?.({
          callSettings: { temperature: 0.25, maxOutputTokens: 8_192 },
          modelMessages: secondStepMessages,
          tools: {},
          stream: true,
        })
        // The second step's envelope must be durable before the provider
        // receives the follow-up request.
        snapshotsAtSecondDispatch(
          harness.persisted.at(-1)?.message.generationRequests?.map(({ capturedAt }) => capturedAt)
        )
        yield { type: 'finish', finishReason: 'stop' } as ModelStreamPart<ToolSet>
      })()
    )

    await harness.service.orchestrate('session-1', targetMessage())

    expect(snapshotsAtSecondDispatch).toHaveBeenCalledWith([1_000, 4_000])
    expect(lastPersisted(harness).generationRequests?.map(({ capturedAt }) => capturedAt)).toEqual([1_000, 4_000])
    expect(lastPersisted(harness).contentParts).toEqual([{ type: 'text', text: 'First step output' }])
  })

  it('does not start the provider when the request snapshot checkpoint fails', async () => {
    const missingSession = new Error('Session session-1 not found')
    harness.failPersistenceFromCall(2, missingSession)
    const chatStream = vi.fn(() => stream([]))
    harness.setChatStreamFactory(chatStream)

    await harness.service.orchestrate('session-1', targetMessage())

    expect(chatStream).not.toHaveBeenCalled()
  })

  it('does not retain a snapshot after a transient pre-dispatch checkpoint failure', async () => {
    harness.failPersistenceOnCall(2, new Error('snapshot checkpoint failed'))
    const chatStream = vi.fn(() => stream([]))
    harness.setChatStreamFactory(chatStream)

    await harness.service.orchestrate('session-1', targetMessage())

    expect(chatStream).not.toHaveBeenCalled()
    expect(lastPersisted(harness).generationRequests).toBeUndefined()
    expect(lastPersisted(harness).error).toBe('snapshot checkpoint failed')
  })

  it('removes a checkpointed snapshot when cancellation wins during the checkpoint write', async () => {
    const externalAbortController = new AbortController()
    harness.runOnPersistenceCall(2, () => externalAbortController.abort())
    const chatStream = vi.fn(() => stream([]))
    harness.setChatStreamFactory(chatStream)

    await harness.service.orchestrate('session-1', targetMessage(), {
      externalAbortSignal: externalAbortController.signal,
    })

    expect(chatStream).not.toHaveBeenCalled()
    expect(harness.persisted.some(({ message }) => message.generationRequests?.length === 1)).toBe(true)
    expect(lastPersisted(harness).generationRequests).toBeUndefined()
    expect(lastPersisted(harness)).toMatchObject({ generating: false, finishReason: 'canceled' })
  })

  it('keeps a committed snapshot when cancellation wins after the checkpoint resolves', async () => {
    const externalAbortController = new AbortController()
    harness.runBeforeProviderDispatch(() => externalAbortController.abort())
    const chatStream = vi.fn(() => stream([]))
    harness.setChatStreamFactory(chatStream)

    await harness.service.orchestrate('session-1', targetMessage(), {
      externalAbortSignal: externalAbortController.signal,
    })

    expect(chatStream).not.toHaveBeenCalled()
    // The checkpoint is durable, so the recorded request survives the abort
    // even though the provider never received it. Accepted trade-off: the
    // window between checkpoint persistence and dispatch is not tracked.
    expect(lastPersisted(harness).generationRequests?.map(({ capturedAt }) => capturedAt)).toEqual([1_000])
    expect(lastPersisted(harness)).toMatchObject({ generating: false, finishReason: 'canceled' })
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

    expect(harness.persisted).toHaveLength(4)
    expect(harness.persisted[2].refreshCounting).toBe(false)
    expect(harness.persisted[2].message.contentParts).toEqual([
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

  it('persists a runtime abort as a non-error terminal state', async () => {
    harness.setStreamFactory(() =>
      (async function* abortedStream() {
        await Promise.resolve()
        harness.runtime.abort('session-1', 'assistant-1')
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
    await vi.waitFor(() => expect(harness.runtime.get('session-1', 'assistant-1')).toBeDefined())

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
    harness.failPersistenceFromCall(3, missingSession)
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

    expect(harness.persisted).toHaveLength(4)
    expect(harness.persisted[2].message.contentParts).toEqual([{ type: 'text', text: 'first second' }])
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
          pauseReason: { type: 'user_exec_approval', command: 'pwd', workdir: '/workspace' },
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
        approvalWorkdir: '/workspace',
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
