import type { LoggerPort, SessionRepositoryPort } from '../../ports'
import type { Session, SessionMetaPage, SessionMetaRecord, SessionSettings, Updater } from '../../types'
import type { SessionWriteCoordinator } from './SessionWriteCoordinator'
import type { SessionEventBus } from './session-events'
import {
  assertNoMessageDataUpdate,
  createSessionMetaRecord,
  getSessionMetadataSnapshot,
  hasSessionMetaFields,
  type SessionMetadataUpdate,
} from './session-metadata'

export interface SessionServiceOptions {
  createId: () => string
  logger?: LoggerPort
  now?: () => number
  getLastUsedModels?: () => {
    chat?: Partial<SessionSettings>
    picture?: Partial<SessionSettings>
  }
  getVisibleSessionMetas?: () => SessionMetaRecord[]
}

function describeError(error: unknown): unknown {
  if (!(error instanceof Error)) return error
  const cause = 'cause' in error ? error.cause : undefined
  return {
    name: error.name,
    message: error.message,
    stack: error.stack,
    ...(cause === undefined ? {} : { cause: describeError(cause) }),
  }
}

export interface UpdateSessionOptions {
  preserveCachedGeneratingMessages?: boolean
}

async function runInChunks<T>(items: T[], chunkSize: number, worker: (item: T) => Promise<void>): Promise<void> {
  for (let index = 0; index < items.length; index += chunkSize) {
    await Promise.all(items.slice(index, index + chunkSize).map((item) => worker(item)))
  }
}

export class SessionService {
  private readonly now: () => number
  private readonly getLastUsedModels: NonNullable<SessionServiceOptions['getLastUsedModels']>
  private readonly getVisibleSessionMetas: NonNullable<SessionServiceOptions['getVisibleSessionMetas']>
  private initialization: Promise<void> | null = null

  constructor(
    readonly repository: SessionRepositoryPort,
    readonly writes: SessionWriteCoordinator,
    readonly events: SessionEventBus,
    private readonly options: SessionServiceOptions
  ) {
    this.now = options.now ?? (() => Date.now())
    this.getLastUsedModels = options.getLastUsedModels ?? (() => ({}))
    this.getVisibleSessionMetas = options.getVisibleSessionMetas ?? (() => [])
  }

  initialize(): Promise<void> {
    if (!this.initialization) {
      this.initialization = this.repository.initialize()
    }
    return this.initialization
  }

  async getSession(sessionId: string): Promise<Session | null> {
    await this.initialize()
    try {
      return await this.repository.getSession(sessionId)
    } catch (error) {
      await this.log('error', 'Failed to read session from repository', {
        sessionId,
        error: describeError(error),
      })
      throw error
    }
  }

  async listSessionsMetaPage(cursor: number, limit?: number): Promise<SessionMetaPage> {
    await this.initialize()
    try {
      return await this.repository.meta.getPage(cursor, limit)
    } catch (error) {
      await this.log('error', 'Failed to read session list page from repository', {
        cursor,
        limit,
        error: describeError(error),
      })
      throw error
    }
  }

  async listArchivedSessionsMetaPage(cursor: number, limit?: number): Promise<SessionMetaPage> {
    await this.initialize()
    return this.repository.meta.getArchivedPage(cursor, limit)
  }

  async countSessionsMeta(): Promise<number> {
    await this.initialize()
    return this.repository.meta.getTotal()
  }

  async countArchivedSessionsMeta(): Promise<number> {
    await this.initialize()
    return this.repository.meta.getArchivedTotal()
  }

  async listAllSessionsMeta(): Promise<SessionMetaRecord[]> {
    const items: SessionMetaRecord[] = []
    let cursor: number | null = 0
    while (cursor !== null) {
      const page = await this.listSessionsMetaPage(cursor)
      items.push(...page.items)
      cursor = page.nextCursor
    }
    return items
  }

  async listArchivedSessionsMeta(): Promise<SessionMetaRecord[]> {
    const items: SessionMetaRecord[] = []
    let cursor: number | null = 0
    while (cursor !== null) {
      const page = await this.listArchivedSessionsMetaPage(cursor)
      items.push(...page.items)
      cursor = page.nextCursor
    }
    return items
  }

  async createSession(newSession: Omit<Session, 'id'>, previousId?: string): Promise<Session> {
    await this.initialize()
    const lastUsedModels = this.getLastUsedModels()
    const session: Session = {
      ...newSession,
      id: this.options.createId(),
      settings: {
        ...(newSession.type === 'picture' ? lastUsedModels.picture : lastUsedModels.chat),
        ...newSession.settings,
      },
    }

    await this.repository.setSession(session)

    let sortOrder = this.now()
    if (previousId) {
      const currentList = this.getVisibleSessionMetas()
      const previousIndex = currentList.findIndex((item) => item.id === previousId)
      if (previousIndex >= 0) {
        const previousSortOrder = currentList[previousIndex].sortOrder
        const nextSortOrder =
          previousIndex + 1 < currentList.length ? currentList[previousIndex + 1].sortOrder : previousSortOrder - 2000
        sortOrder = (previousSortOrder + nextSortOrder) / 2
      }
    }

    const record = createSessionMetaRecord(session, sortOrder, this.now())
    await this.repository.meta.create(record)
    this.writes.prime(session)
    await this.events.publish({ type: 'session-created', session, record })
    return session
  }

  async updateSessionWithMessages(
    sessionId: string,
    updater: Updater<Session>,
    options: UpdateSessionOptions = {}
  ): Promise<Session> {
    await this.initialize()
    const updateMeta = typeof updater === 'function' || hasSessionMetaFields(updater)
    const result = await this.writes.update(sessionId, updater, { updateMeta })
    await this.events.publish({
      type: 'session-updated',
      session: result.session,
      meta: result.meta,
      preserveCachedGeneratingMessages: options.preserveCachedGeneratingMessages === true,
    })
    return result.session
  }

  updateSession(sessionId: string, updater: Updater<SessionMetadataUpdate>): Promise<Session> {
    return this.updateSessionWithMessages(
      sessionId,
      (session) => {
        if (!session) {
          throw new Error(`Session ${sessionId} not found`)
        }
        const update = typeof updater === 'function' ? updater(getSessionMetadataSnapshot(session)) : updater
        assertNoMessageDataUpdate(update)
        return { ...session, ...update }
      },
      { preserveCachedGeneratingMessages: true }
    )
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.initialize()
    await this.events.publish({
      type: 'session-will-delete',
      ids: [sessionId],
      operation: 'session deletion',
    })
    await this.repository.deleteSession(sessionId)
    await this.repository.meta.delete(sessionId)
    this.writes.forget(sessionId)
    await this.events.publish({ type: 'session-deleted', ids: [sessionId] })
  }

  async deleteSessions(sessionIds: string[]): Promise<void> {
    await this.initialize()
    const uniqueIds = [...new Set(sessionIds)]
    if (uniqueIds.length === 0) return

    await this.events.publish({
      type: 'session-will-delete',
      ids: uniqueIds,
      operation: 'bulk session deletion',
    })
    await runInChunks(uniqueIds, 20, (sessionId) => this.repository.deleteSession(sessionId))
    await this.repository.meta.deleteMany(uniqueIds)
    for (const sessionId of uniqueIds) {
      this.writes.forget(sessionId)
    }
    await this.events.publish({ type: 'session-deleted', ids: uniqueIds })
    await this.publishListReset({ visible: true, archived: true })
  }

  async archiveSession(sessionId: string): Promise<void> {
    await this.updateSession(sessionId, { hidden: true, archivedAt: this.now() })
    await this.publishListReset({ archived: true })
  }

  async archiveSessions(sessionIds: string[]): Promise<void> {
    const uniqueIds = [...new Set(sessionIds)]
    if (uniqueIds.length === 0) return

    const archivedAt = this.now()
    const missingSessionIds: string[] = []
    await runInChunks(uniqueIds, 20, async (sessionId) => {
      try {
        await this.updateSession(sessionId, { hidden: true, archivedAt })
      } catch (error) {
        if (error instanceof Error && error.message === `Session ${sessionId} not found`) {
          missingSessionIds.push(sessionId)
          return
        }
        throw error
      }
    })

    if (missingSessionIds.length > 0) {
      await this.events.publish({
        type: 'session-will-delete',
        ids: missingSessionIds,
        operation: 'stale session meta cleanup',
      })
      await this.repository.meta.deleteMany(missingSessionIds)
      for (const sessionId of missingSessionIds) {
        this.writes.forget(sessionId)
      }
      await this.events.publish({ type: 'session-deleted', ids: missingSessionIds })
    }
    await this.publishListReset({ visible: true, archived: true })
  }

  async restoreSession(sessionId: string): Promise<void> {
    await this.updateSession(sessionId, { hidden: false, archivedAt: undefined })
    await this.publishListReset({ visible: true, archived: true })
  }

  async recoverSessionList(): Promise<{ recovered: number; failed: number }> {
    await this.initialize()
    const sessionIds = await this.repository.getAllSessionIds()
    const sessionsWithTimestamp: Array<{ session: Session; timestamp: number }> = []
    const failedSessionIds: string[] = []

    for (const sessionId of sessionIds) {
      try {
        const session = await this.repository.getSession(sessionId)
        if (session?.id) {
          sessionsWithTimestamp.push({
            session,
            timestamp: session.messages[0]?.timestamp ?? 0,
          })
        }
      } catch (error) {
        failedSessionIds.push(sessionId)
        await this.log('error', 'Failed to read session during session-list recovery', {
          sessionId,
          error: describeError(error),
        })
      }
    }

    if (failedSessionIds.length > 0) {
      await this.log('warn', 'Failed to recover sessions due to read errors', {
        failed: failedSessionIds.length,
        sessionIds: failedSessionIds,
      })
    }

    sessionsWithTimestamp.sort((left, right) => left.timestamp - right.timestamp)
    const now = this.now()
    const records = sessionsWithTimestamp.map(({ session, timestamp }, index) =>
      createSessionMetaRecord(
        session,
        timestamp || now - (sessionsWithTimestamp.length - index) * 1000,
        timestamp || now - (sessionsWithTimestamp.length - index) * 1000
      )
    )
    await this.repository.meta.clear()
    await this.repository.meta.createMany(records)
    await this.publishListReset({ visible: true, archived: true })
    return { recovered: records.length, failed: failedSessionIds.length }
  }

  private async log(level: 'error' | 'warn', message: string, context: Record<string, unknown>): Promise<void> {
    if (!this.options.logger) return
    await Promise.resolve(this.options.logger.log(level, message, context)).catch(() => {})
  }

  private async publishListReset(options: { visible?: boolean; archived?: boolean }): Promise<void> {
    const [visible, archived] = await Promise.all([
      options.visible ? this.listSessionsMetaPage(0) : Promise.resolve(undefined),
      options.archived ? this.listArchivedSessionsMetaPage(0) : Promise.resolve(undefined),
    ])
    await this.events.publish({ type: 'session-list-reset', visible, archived })
  }
}
