import type { SessionRepositoryPort } from '../../ports'
import type { Session, SessionMeta, Updater } from '../../types'
import { projectSessionMeta } from './session-metadata'

export interface SessionWriteResult {
  session: Session
  meta: SessionMeta | null
}

export interface SessionWriteOptions {
  updateMeta?: boolean
}

export interface SessionWriteCoordinatorOptions {
  /**
   * The current Renderer injects a React Query-backed reader so the first
   * persisted write starts from cache-only streaming state when it exists.
   * Other hosts can inject their own read model or use repository reads.
   */
  readCurrentSession?: (sessionId: string) => Promise<Session | null>
}

/**
 * Serializes read-modify-write operations per session id.
 *
 * The in-memory state is updated only after the full session write succeeds.
 * A failed operation does not poison the tail: later writes can still run.
 * After the first read or `prime`, that snapshot remains the source for later
 * updates. Runtime full-session writes must therefore go through this coordinator.
 * Restore/import code that writes the repository directly must call `forget` for
 * every affected id before another update, or recreate/reload the runtime.
 */
export class SessionWriteCoordinator {
  private readonly current = new Map<string, Session>()
  private readonly tails = new Map<string, Promise<void>>()
  private readonly readCurrentSession: (sessionId: string) => Promise<Session | null>

  constructor(
    private readonly repository: SessionRepositoryPort,
    options: SessionWriteCoordinatorOptions = {}
  ) {
    this.readCurrentSession = options.readCurrentSession ?? ((sessionId) => this.repository.getSession(sessionId))
  }

  update(sessionId: string, updater: Updater<Session>, options: SessionWriteOptions = {}): Promise<SessionWriteResult> {
    const previousTail = this.tails.get(sessionId) ?? Promise.resolve()
    const operation = previousTail.catch(() => undefined).then(() => this.performUpdate(sessionId, updater, options))
    const nextTail = operation.then(
      () => undefined,
      () => undefined
    )
    this.tails.set(sessionId, nextTail)
    void nextTail.then(() => {
      if (this.tails.get(sessionId) === nextTail) {
        this.tails.delete(sessionId)
      }
    })
    return operation
  }

  prime(session: Session): void {
    this.current.set(session.id, session)
  }

  forget(sessionId: string): void {
    this.current.delete(sessionId)
    this.tails.delete(sessionId)
  }

  private async performUpdate(
    sessionId: string,
    updater: Updater<Session>,
    options: SessionWriteOptions
  ): Promise<SessionWriteResult> {
    const previous = this.current.get(sessionId) ?? (await this.readCurrentSession(sessionId))
    if (!previous) {
      throw new Error(`Session ${sessionId} not found`)
    }

    const updated = typeof updater === 'function' ? updater(previous) : { ...previous, ...updater }
    await this.repository.setSession(updated)
    this.current.set(sessionId, updated)

    const meta = options.updateMeta === false ? null : projectSessionMeta(updated)
    if (meta) {
      await this.repository.meta.update(sessionId, meta)
    }
    return { session: updated, meta }
  }
}
