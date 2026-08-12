import type {
  Session,
  SessionApplicationEvent,
  SessionEventBus,
  SessionMetaPage,
  SessionMetaRecord,
  Updater,
} from '@chatbox/core'
import { sortSessionRecords } from '@chatbox/core/utils/session-sort'
import type { InfiniteData, QueryClient } from '@tanstack/react-query'
import { QueryKeys } from './query-keys'
import { mergeCachedGeneratingMessages } from './session-cache-policy'
import {
  createSessionQueryDefinitions,
  type SessionQueryDefinitions,
  type SessionQuerySource,
} from './session-query-options'

export type InfiniteSessionData = InfiniteData<SessionMetaPage, number>

function updateListData(
  queryClient: QueryClient,
  queryKey: string[],
  updater: (items: SessionMetaRecord[]) => SessionMetaRecord[]
): void {
  queryClient.setQueryData<InfiniteSessionData>(queryKey, (old) => {
    if (!old || old.pages.length === 0) return old
    const allItems = old.pages.flatMap((page) => page.items)
    const updated = updater(allItems)
    const lastPage = old.pages[old.pages.length - 1]
    const delta = updated.length - allItems.length
    return {
      pages: [
        {
          items: updated,
          nextCursor: lastPage.nextCursor !== null ? lastPage.nextCursor + delta : null,
          total: (lastPage.total || 0) + delta,
        },
      ],
      pageParams: [0],
    }
  })
}

export class SessionQueryBridge {
  readonly definitions: SessionQueryDefinitions
  private readonly unsubscribe: () => void

  constructor(
    private readonly queryClient: QueryClient,
    source: SessionQuerySource,
    events: SessionEventBus
  ) {
    this.definitions = createSessionQueryDefinitions(source)
    this.unsubscribe = events.subscribe((event) => this.project(event))
  }

  dispose(): void {
    this.unsubscribe()
  }

  getCachedSessionsMeta(): SessionMetaRecord[] {
    const data = this.queryClient.getQueryData<InfiniteSessionData>(QueryKeys.ChatSessionsList)
    return data?.pages.flatMap((page) => page.items) ?? []
  }

  getCachedSession(sessionId: string): Session | null | undefined {
    return this.queryClient.getQueryData<Session | null>(QueryKeys.ChatSession(sessionId))
  }

  async listSessionsMeta(): Promise<SessionMetaRecord[]> {
    const cached = this.getCachedSessionsMeta()
    if (cached.length > 0) return cached
    const data = await this.queryClient.fetchInfiniteQuery(this.definitions.sessions)
    return data.pages.flatMap((page) => page.items)
  }

  getSession(sessionId: string): Promise<Session | null> {
    return this.queryClient.fetchQuery(this.definitions.session(sessionId))
  }

  discardSessionCache(sessionId: string): void {
    this.queryClient.removeQueries({ queryKey: QueryKeys.ChatSession(sessionId), exact: true })
  }

  updateSessionListData(updater: (items: SessionMetaRecord[]) => SessionMetaRecord[]): void {
    updateListData(this.queryClient, QueryKeys.ChatSessionsList, updater)
  }

  updateArchivedSessionListData(updater: (items: SessionMetaRecord[]) => SessionMetaRecord[]): void {
    updateListData(this.queryClient, QueryKeys.ArchivedChatSessionsList, updater)
  }

  resetSessionList(page: SessionMetaPage): void {
    this.queryClient.setQueryData<InfiniteSessionData>(QueryKeys.ChatSessionsList, {
      pages: [page],
      pageParams: [0],
    })
  }

  resetArchivedSessionList(page: SessionMetaPage): void {
    this.queryClient.setQueryData<InfiniteSessionData>(QueryKeys.ArchivedChatSessionsList, {
      pages: [page],
      pageParams: [0],
    })
  }

  updateSessionCache(sessionId: string, updater: Updater<Session>): void {
    this.queryClient.setQueryData(QueryKeys.ChatSession(sessionId), (old: Session | null | undefined) => {
      if (!old) return old
      return typeof updater === 'function' ? updater(old) : { ...old, ...updater }
    })
  }

  private project(event: SessionApplicationEvent): void {
    switch (event.type) {
      case 'session-created':
        this.queryClient.setQueryData(QueryKeys.ChatSession(event.session.id), event.session)
        this.updateSessionListData((items) => sortSessionRecords([...items, event.record]))
        break
      case 'session-updated':
        if (event.preserveCachedGeneratingMessages) {
          this.queryClient.setQueryData(QueryKeys.ChatSession(event.session.id), (cached: Session | null | undefined) =>
            mergeCachedGeneratingMessages(event.session, cached)
          )
        } else {
          this.queryClient.setQueryData(QueryKeys.ChatSession(event.session.id), event.session)
        }
        if (event.meta) {
          this.updateSessionListData((items) =>
            sortSessionRecords(items.map((item) => (item.id === event.session.id ? { ...item, ...event.meta } : item)))
          )
        }
        break
      case 'session-deleted': {
        const ids = new Set(event.ids)
        for (const sessionId of ids) {
          this.queryClient.setQueryData(QueryKeys.ChatSession(sessionId), null)
        }
        this.updateSessionListData((items) => items.filter((item) => !ids.has(item.id)))
        this.updateArchivedSessionListData((items) => items.filter((item) => !ids.has(item.id)))
        break
      }
      case 'session-list-reset':
        if (event.visible) this.resetSessionList(event.visible)
        if (event.archived) this.resetArchivedSessionList(event.archived)
        break
      case 'session-will-delete':
        break
    }
  }
}

export { SessionQueryBridge as ApplicationQueryBridge }
