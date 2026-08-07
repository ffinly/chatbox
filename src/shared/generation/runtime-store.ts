export type GenerationRuntimePhase = 'preparing' | 'streaming' | 'paused'

export interface GenerationRuntimeState {
  readonly sessionId: string
  readonly messageId: string
  readonly phase: GenerationRuntimePhase
  readonly abortController: AbortController
}

export interface GenerationRuntimeStoreOptions {
  createAbortController?: () => AbortController
}

/**
 * Owns transient generation controls outside persisted Session/Message data.
 *
 * A Session can temporarily have multiple runtimes because alternative replies
 * intentionally bypass the per-session generation lock. A new runtime replaces
 * only an older runtime for the same message. Persisted messages may still expose
 * compatibility fields such as `generating` and `cancel`, but AbortControllers
 * always remain in this in-memory store.
 */
export class GenerationRuntimeStore {
  private readonly states = new Map<string, Map<string, GenerationRuntimeState>>()
  private readonly unsettledStreamDrains = new Map<string, Set<Promise<void>>>()
  private readonly listeners = new Set<() => void>()
  private readonly createAbortController: () => AbortController

  constructor(options: GenerationRuntimeStoreOptions = {}) {
    this.createAbortController = options.createAbortController ?? (() => new AbortController())
  }

  start(sessionId: string, messageId: string): GenerationRuntimeState {
    const sessionStates = this.getOrCreateSessionStates(sessionId)
    sessionStates.get(messageId)?.abortController.abort()
    const state: GenerationRuntimeState = {
      sessionId,
      messageId,
      phase: 'preparing',
      abortController: this.createAbortController(),
    }
    sessionStates.set(messageId, state)
    this.notify()
    return state
  }

  get(sessionId: string, messageId?: string): GenerationRuntimeState | undefined {
    const sessionStates = this.states.get(sessionId)
    if (!sessionStates) return undefined
    if (messageId !== undefined) return sessionStates.get(messageId)
    return [...sessionStates.values()].at(-1)
  }

  setPhase(
    sessionId: string,
    messageId: string,
    phase: GenerationRuntimePhase,
    expected?: GenerationRuntimeState
  ): GenerationRuntimeState | undefined {
    const current = this.getMatchingState(sessionId, messageId, expected)
    if (!current) return undefined
    const next = { ...current, phase }
    this.states.get(sessionId)?.set(messageId, next)
    this.notify()
    return next
  }

  abort(sessionId: string, messageId?: string, reason?: unknown, expected?: GenerationRuntimeState): boolean {
    if (messageId === undefined) {
      const sessionStates = this.states.get(sessionId)
      if (!sessionStates) return false
      for (const state of sessionStates.values()) state.abortController.abort(reason)
      this.states.delete(sessionId)
      this.notify()
      return true
    }
    const current = this.getMatchingState(sessionId, messageId, expected)
    if (!current) return false
    current.abortController.abort(reason)
    this.deleteState(sessionId, messageId)
    this.notify()
    return true
  }

  /**
   * Releases a finished active runtime while preserving a paused runtime for
   * the later continue/stop action.
   */
  finishActive(sessionId: string, messageId: string, expected?: GenerationRuntimeState): boolean {
    const current = this.getMatchingState(sessionId, messageId, expected)
    if (!current || current.phase === 'paused') return false
    this.deleteState(sessionId, messageId)
    this.notify()
    return true
  }

  clear(sessionId: string, messageId?: string, expected?: GenerationRuntimeState): boolean {
    if (messageId === undefined) {
      const deleted = this.states.delete(sessionId)
      if (deleted) this.notify()
      return deleted
    }
    const current = this.getMatchingState(sessionId, messageId, expected)
    if (!current) return false
    this.deleteState(sessionId, messageId)
    this.notify()
    return true
  }

  /**
   * Retain a provider stream that is still unwinding after Stop. Generation
   * entry points use this barrier even when they intentionally bypass the
   * normal per-session generation lock.
   */
  registerUnsettledStreamDrain(sessionId: string, drain: Promise<void>): void {
    let drains = this.unsettledStreamDrains.get(sessionId)
    if (!drains) {
      drains = new Set()
      this.unsettledStreamDrains.set(sessionId, drains)
    }
    drains.add(drain)
    const cleanup = () => {
      drains.delete(drain)
      if (drains.size === 0 && this.unsettledStreamDrains.get(sessionId) === drains) {
        this.unsettledStreamDrains.delete(sessionId)
      }
    }
    drain.then(cleanup, cleanup)
  }

  /** Resolves once every currently registered unsettled stream for a Session has drained. */
  waitForUnsettledStreamDrains(sessionId: string): Promise<void> | undefined {
    const drains = this.unsettledStreamDrains.get(sessionId)
    if (!drains || drains.size === 0) return undefined
    return Promise.all([...drains]).then(() => {})
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  dispose(): void {
    const hadStates = this.states.size > 0
    for (const sessionStates of this.states.values()) {
      for (const state of sessionStates.values()) state.abortController.abort()
    }
    this.states.clear()
    this.unsettledStreamDrains.clear()
    if (hadStates) this.notify()
    this.listeners.clear()
  }

  private getOrCreateSessionStates(sessionId: string): Map<string, GenerationRuntimeState> {
    let sessionStates = this.states.get(sessionId)
    if (!sessionStates) {
      sessionStates = new Map()
      this.states.set(sessionId, sessionStates)
    }
    return sessionStates
  }

  private getMatchingState(
    sessionId: string,
    messageId: string,
    expected?: GenerationRuntimeState
  ): GenerationRuntimeState | undefined {
    const current = this.states.get(sessionId)?.get(messageId)
    return current && (!expected || current.abortController === expected.abortController) ? current : undefined
  }

  private deleteState(sessionId: string, messageId: string): void {
    const sessionStates = this.states.get(sessionId)
    if (!sessionStates) return
    sessionStates.delete(messageId)
    if (sessionStates.size === 0) this.states.delete(sessionId)
  }

  private notify(): void {
    for (const listener of this.listeners) listener()
  }
}
