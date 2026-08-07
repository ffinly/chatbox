import { afterEach, describe, expect, it, vi } from 'vitest'
import { GenerationRuntimeStore } from './runtime-store'

describe('GenerationRuntimeStore', () => {
  const stores: GenerationRuntimeStore[] = []

  function createStore(): GenerationRuntimeStore {
    const store = new GenerationRuntimeStore()
    stores.push(store)
    return store
  }

  afterEach(() => {
    for (const store of stores.splice(0)) store.dispose()
  })

  it('starts each runtime in the preparing phase', () => {
    const store = createStore()
    const state = store.start('session-1', 'message-1')

    expect(state).toMatchObject({
      sessionId: 'session-1',
      messageId: 'message-1',
      phase: 'preparing',
    })
    expect(state.abortController.signal.aborted).toBe(false)
    expect(store.get('session-1')).toBe(state)
  })

  it('transitions only the matching message runtime', () => {
    const store = createStore()
    store.start('session-1', 'message-1')

    expect(store.setPhase('session-1', 'stale-message', 'streaming')).toBeUndefined()
    expect(store.get('session-1')?.phase).toBe('preparing')
    expect(store.setPhase('session-1', 'message-1', 'streaming')?.phase).toBe('streaming')
  })

  it('aborts and removes the matching runtime', () => {
    const store = createStore()
    const state = store.start('session-1', 'message-1')
    const abortListener = vi.fn()
    state.abortController.signal.addEventListener('abort', abortListener)

    expect(store.abort('session-1', 'stale-message')).toBe(false)
    expect(state.abortController.signal.aborted).toBe(false)
    expect(store.abort('session-1', 'message-1', 123_456)).toBe(true)
    expect(state.abortController.signal.aborted).toBe(true)
    expect(state.abortController.signal.reason).toBe(123_456)
    expect(abortListener).toHaveBeenCalledOnce()
    expect(store.get('session-1')).toBeUndefined()
  })

  it('finishes active runtimes but preserves paused runtimes', () => {
    const store = createStore()
    store.start('session-1', 'message-1')
    expect(store.finishActive('session-1', 'message-1')).toBe(true)
    expect(store.get('session-1')).toBeUndefined()

    store.start('session-1', 'message-2')
    store.setPhase('session-1', 'message-2', 'paused')
    expect(store.finishActive('session-1', 'message-2')).toBe(false)
    expect(store.get('session-1')?.phase).toBe('paused')
    expect(store.clear('session-1', 'message-2')).toBe(true)
    expect(store.get('session-1')).toBeUndefined()
  })

  it('keeps concurrent alternative-message runtimes in the same Session', () => {
    const store = createStore()
    const first = store.start('session-1', 'message-1')
    const second = store.start('session-1', 'message-2')

    expect(first.abortController.signal.aborted).toBe(false)
    expect(store.get('session-1', 'message-1')).toBe(first)
    expect(store.get('session-1')).toBe(second)
    expect(store.finishActive('session-1', 'message-1', first)).toBe(true)
    expect(store.get('session-1', 'message-2')).toBe(second)
  })

  it('replaces the same message runtime and ignores its stale completion', () => {
    const store = createStore()
    const first = store.start('session-1', 'message-1')
    const replacement = store.start('session-1', 'message-1')

    expect(first.abortController.signal.aborted).toBe(true)
    expect(store.finishActive('session-1', 'message-1', first)).toBe(false)
    expect(store.get('session-1', 'message-1')).toBe(replacement)
  })

  it('isolates runtimes by session', () => {
    const store = createStore()
    const first = store.start('session-1', 'message-1')
    const second = store.start('session-2', 'message-2')

    expect(store.get('session-1')).toBe(first)
    expect(store.get('session-2')).toBe(second)
  })

  it('tracks unsettled stream drains per session until they resolve', async () => {
    const store = createStore()
    let finishDrain: (() => void) | undefined
    const drain = new Promise<void>((resolve) => {
      finishDrain = resolve
    })

    store.registerUnsettledStreamDrain('session-1', drain)

    const barrier = store.waitForUnsettledStreamDrains('session-1')
    expect(barrier).toBeInstanceOf(Promise)
    expect(store.waitForUnsettledStreamDrains('session-2')).toBeUndefined()

    finishDrain?.()
    await barrier
    await Promise.resolve()
    expect(store.waitForUnsettledStreamDrains('session-1')).toBeUndefined()
  })

  it('notifies React bindings only for successful state changes', () => {
    const store = createStore()
    const listener = vi.fn()
    const unsubscribe = store.subscribe(listener)

    store.start('session-1', 'message-1')
    store.setPhase('session-1', 'stale-message', 'streaming')
    store.setPhase('session-1', 'message-1', 'streaming')
    store.clear('session-1', 'message-1')

    expect(listener).toHaveBeenCalledTimes(3)
    unsubscribe()
    store.start('session-2', 'message-2')
    expect(listener).toHaveBeenCalledTimes(3)
  })

  it('aborts all retained controllers when disposed', () => {
    const store = createStore()
    const first = store.start('session-1', 'message-1')
    const second = store.start('session-2', 'message-2')

    store.dispose()

    expect(first.abortController.signal.aborted).toBe(true)
    expect(second.abortController.signal.aborted).toBe(true)
    expect(store.get('session-1')).toBeUndefined()
    expect(store.get('session-2')).toBeUndefined()
  })
})
