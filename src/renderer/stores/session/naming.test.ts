import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { generateText, createModel, updateSession, getSession, getSettings } = vi.hoisted(() => ({
  generateText: vi.fn(),
  createModel: vi.fn(),
  updateSession: vi.fn(),
  getSession: vi.fn(),
  getSettings: vi.fn(),
}))

vi.mock('@/adapters', () => ({
  createModel,
}))

vi.mock('@/packages/model-calls', () => ({
  generateText,
}))

vi.mock('@/packages/prompts', () => ({
  nameConversation: vi.fn(() => []),
}))

vi.mock('@/utils/sentry', () => ({
  reportError: vi.fn(),
}))

vi.mock('../chatStore', () => ({
  getSession,
  updateSession,
}))

vi.mock('../settingsStore', () => ({
  settingsStore: {
    getState: () => ({
      getSettings,
    }),
  },
}))

import { scheduleGenerateNameAndThreadName } from './naming'
import {
  activeNameGenerations,
  clearSessionNameGenerationState,
  nameGenerationCooldownUntil,
  nameGenerationsDeferredUntilIdle,
  pendingNameGenerations,
} from './state'

function untitledSession(overrides: Record<string, unknown> = {}) {
  return {
    id: 'session-1',
    name: 'Untitled',
    type: 'chat',
    settings: {},
    messages: [
      { id: 'u1', role: 'user', contentParts: [{ type: 'text', text: 'hello' }] },
      { id: 'a1', role: 'assistant', generating: true, contentParts: [{ type: 'text', text: 'hi' }] },
    ],
    ...overrides,
  }
}

describe('scheduleGenerateNameAndThreadName', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    pendingNameGenerations.clear()
    activeNameGenerations.clear()
    nameGenerationsDeferredUntilIdle.clear()
    nameGenerationCooldownUntil.clear()
    getSettings.mockReturnValue({ language: 'en', threadNamingModel: null })
    getSession.mockResolvedValue(
      untitledSession({
        messages: [
          { id: 'u1', role: 'user', contentParts: [{ type: 'text', text: 'hello' }] },
          { id: 'a1', role: 'assistant', contentParts: [{ type: 'text', text: 'hi' }] },
        ],
      })
    )
    createModel.mockResolvedValue({})
    generateText.mockResolvedValue({ contentParts: [{ type: 'text', text: 'Greeting' }] })
    updateSession.mockResolvedValue(undefined)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
    pendingNameGenerations.clear()
    activeNameGenerations.clear()
    nameGenerationsDeferredUntilIdle.clear()
    nameGenerationCooldownUntil.clear()
  })

  it('does not reset the pending timer when schedule is called again during streaming', async () => {
    scheduleGenerateNameAndThreadName('session-1')
    expect(pendingNameGenerations.size).toBe(1)

    scheduleGenerateNameAndThreadName('session-1')
    scheduleGenerateNameAndThreadName('session-1')
    expect(pendingNameGenerations.size).toBe(1)

    await vi.advanceTimersByTimeAsync(1000)

    expect(generateText).toHaveBeenCalledTimes(1)
    expect(updateSession).toHaveBeenCalledWith('session-1', { name: 'Greeting', threadName: 'Greeting' })
  })

  it('skips naming if the in-progress turn became ineligible before the timer fires', async () => {
    getSession.mockResolvedValue(
      untitledSession({
        messages: [
          { id: 'u1', role: 'user', contentParts: [{ type: 'text', text: 'hello' }] },
          {
            id: 'a1',
            role: 'assistant',
            finishReason: 'agent-mode-suggested',
            contentParts: [{ type: 'agent-mode-suggestion', reason: 'needs tools' }],
          },
        ],
      })
    )

    scheduleGenerateNameAndThreadName('session-1')
    await vi.advanceTimersByTimeAsync(1000)

    expect(generateText).not.toHaveBeenCalled()
    expect(updateSession).not.toHaveBeenCalled()
  })

  it('allows a replacement schedule while an ineligible check is still in flight', async () => {
    let resolveFirstRead: ((session: unknown) => void) | undefined
    const eligibleSession = untitledSession()

    getSession.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFirstRead = resolve
        })
    )
    getSession.mockResolvedValue(eligibleSession)

    scheduleGenerateNameAndThreadName('session-1')
    await vi.advanceTimersByTimeAsync(1000)

    // Pending slot is free during the async eligibility read, so a later Header
    // update can queue another attempt instead of getting stuck behind active.
    expect(pendingNameGenerations.size).toBe(0)
    expect(activeNameGenerations.size).toBe(0)
    scheduleGenerateNameAndThreadName('session-1')
    expect(pendingNameGenerations.size).toBe(1)

    resolveFirstRead?.(
      untitledSession({
        messages: [
          { id: 'u1', role: 'user', contentParts: [{ type: 'text', text: 'hello' }] },
          {
            id: 'a1',
            role: 'assistant',
            finishReason: 'agent-mode-suggested',
            contentParts: [{ type: 'agent-mode-suggestion', reason: 'needs tools' }],
          },
        ],
      })
    )
    await Promise.resolve()

    expect(generateText).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1000)

    expect(generateText).toHaveBeenCalledTimes(1)
    expect(updateSession).toHaveBeenCalledWith('session-1', { name: 'Greeting', threadName: 'Greeting' })
  })

  it('does not retry naming on every streaming update after a failed attempt', async () => {
    const streamingSession = untitledSession()
    getSession.mockResolvedValue(streamingSession)
    generateText.mockRejectedValue(new Error('naming model unavailable'))

    scheduleGenerateNameAndThreadName('session-1', { messages: streamingSession.messages })
    await vi.advanceTimersByTimeAsync(1000)
    await Promise.resolve()
    await Promise.resolve()

    expect(generateText).toHaveBeenCalledTimes(1)
    expect(nameGenerationsDeferredUntilIdle.has('name-session-1')).toBe(true)

    scheduleGenerateNameAndThreadName('session-1', { messages: streamingSession.messages })
    scheduleGenerateNameAndThreadName('session-1', { messages: streamingSession.messages })
    expect(pendingNameGenerations.size).toBe(0)
    expect(generateText).toHaveBeenCalledTimes(1)
  })

  it('retries once after streaming settles following a deferred failure', async () => {
    const streamingSession = untitledSession()
    getSession.mockResolvedValue(streamingSession)
    generateText.mockRejectedValueOnce(new Error('naming model unavailable'))
    generateText.mockResolvedValue({ contentParts: [{ type: 'text', text: 'Greeting' }] })

    scheduleGenerateNameAndThreadName('session-1', { messages: streamingSession.messages })
    await vi.advanceTimersByTimeAsync(1000)
    await Promise.resolve()
    await Promise.resolve()

    expect(generateText).toHaveBeenCalledTimes(1)
    expect(nameGenerationsDeferredUntilIdle.has('name-session-1')).toBe(true)

    const settledMessages = [
      { id: 'u1', role: 'user', contentParts: [{ type: 'text', text: 'hello' }] },
      { id: 'a1', role: 'assistant', contentParts: [{ type: 'text', text: 'hi' }] },
    ]
    getSession.mockResolvedValue(untitledSession({ messages: settledMessages }))

    scheduleGenerateNameAndThreadName('session-1', { messages: settledMessages })
    expect(pendingNameGenerations.size).toBe(1)

    await vi.advanceTimersByTimeAsync(1000)

    expect(generateText).toHaveBeenCalledTimes(2)
    expect(updateSession).toHaveBeenCalledWith('session-1', { name: 'Greeting', threadName: 'Greeting' })
  })

  it('does not write back or record retry state for a session deleted mid-flight', async () => {
    generateText.mockImplementation(async () => {
      // Session is deleted while the naming model call is in flight.
      getSession.mockResolvedValue(undefined)
      return { contentParts: [{ type: 'text', text: 'Greeting' }] }
    })

    scheduleGenerateNameAndThreadName('session-1')
    await vi.advanceTimersByTimeAsync(1000)
    for (let i = 0; i < 5; i++) {
      await Promise.resolve()
    }

    expect(generateText).toHaveBeenCalledTimes(1)
    expect(updateSession).not.toHaveBeenCalled()
    expect(nameGenerationCooldownUntil.size).toBe(0)
    expect(nameGenerationsDeferredUntilIdle.size).toBe(0)
  })

  it('drops pending timers and retry state when a session is deleted', async () => {
    scheduleGenerateNameAndThreadName('session-1')
    nameGenerationsDeferredUntilIdle.add('thread-session-1')
    nameGenerationCooldownUntil.set('name-session-1', Date.now() + 60_000)

    clearSessionNameGenerationState('session-1')

    expect(pendingNameGenerations.size).toBe(0)
    expect(nameGenerationsDeferredUntilIdle.size).toBe(0)
    expect(nameGenerationCooldownUntil.size).toBe(0)

    await vi.advanceTimersByTimeAsync(1000)
    expect(generateText).not.toHaveBeenCalled()
  })
})
