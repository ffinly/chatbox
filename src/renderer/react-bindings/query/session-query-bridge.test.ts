import {
  SessionEventBus,
  SessionNotFoundError,
  SessionService,
  SessionWriteCoordinator,
} from '@shared/application/session'
import {
  createTestRecord,
  createTestSession,
  MemorySessionRepository,
} from '@shared/application/session/__tests__/memory-session-repository'
import type { Message, Session, SessionMetaPage } from '@shared/types'
import { QueryClient } from '@tanstack/react-query'
import { describe, expect, test, vi } from 'vitest'
import { QueryKeys } from './query-keys'
import { type InfiniteSessionData, SessionQueryBridge } from './session-query-bridge'
import { createSessionQueryDefinitions } from './session-query-options'

function createService(repository: MemorySessionRepository, events: SessionEventBus): SessionService {
  return new SessionService(repository, new SessionWriteCoordinator(repository), events, {
    createId: () => 'created',
    now: () => 100,
  })
}

describe('session query definitions', () => {
  test('the same definitions run against independent QueryClient instances', async () => {
    const page: SessionMetaPage = {
      items: [],
      nextCursor: null,
      total: 0,
    }
    const definitions = createSessionQueryDefinitions({
      getSession: () => Promise.resolve(null),
      listSessionsMetaPage: () => Promise.resolve(page),
      listArchivedSessionsMetaPage: () => Promise.resolve(page),
    })
    const firstClient = new QueryClient()
    const secondClient = new QueryClient()

    await firstClient.fetchInfiniteQuery(definitions.sessions)
    await secondClient.fetchInfiniteQuery(definitions.sessions)

    expect(firstClient.getQueryData(QueryKeys.ChatSessionsList)).toEqual(
      secondClient.getQueryData(QueryKeys.ChatSessionsList)
    )
    firstClient.setQueryData(QueryKeys.ChatSessionsList, undefined)
    expect(secondClient.getQueryData(QueryKeys.ChatSessionsList)).toBeDefined()
  })
})

describe('SessionQueryBridge', () => {
  test('failed deletion evicts stale session data before writes reopen', async () => {
    const repository = new MemorySessionRepository()
    const session = createTestSession('session-1')
    repository.sessions.set(session.id, session)
    repository.records.set(session.id, createTestRecord(session, 1))
    const events = new SessionEventBus()
    const queryClient = new QueryClient()
    let bridge: SessionQueryBridge | null = null
    const writes = new SessionWriteCoordinator(repository, {
      readCurrentSession: (sessionId) => (bridge ? bridge.getSession(sessionId) : repository.getSession(sessionId)),
      discardCurrentSession: (sessionId) => bridge?.discardSessionCache(sessionId),
    })
    const service = new SessionService(repository, writes, events, {
      createId: () => 'created',
      now: () => 100,
    })
    bridge = new SessionQueryBridge(queryClient, service, events)
    queryClient.setQueryData(QueryKeys.ChatSession(session.id), {
      ...session,
      name: 'Stale cached session',
    })
    repository.meta.delete = () => Promise.reject(new Error('metadata deletion failed'))

    await expect(service.deleteSession(session.id)).rejects.toThrow('metadata deletion failed')

    expect(queryClient.getQueryData(QueryKeys.ChatSession(session.id))).toBeUndefined()
    await expect(service.updateSession(session.id, { name: 'Must not revive' })).rejects.toBeInstanceOf(
      SessionNotFoundError
    )
    expect(repository.sessions.has(session.id)).toBe(false)
  })

  test('metadata update failure still projects persisted session data into the cache', async () => {
    const repository = new MemorySessionRepository()
    const session = createTestSession('session-1')
    repository.sessions.set(session.id, session)
    repository.records.set(session.id, createTestRecord(session, 1))
    const events = new SessionEventBus()
    const queryClient = new QueryClient()
    let bridge: SessionQueryBridge | null = null
    const writes = new SessionWriteCoordinator(repository, {
      readCurrentSession: (sessionId) => (bridge ? bridge.getSession(sessionId) : repository.getSession(sessionId)),
    })
    const service = new SessionService(repository, writes, events, {
      createId: () => 'created',
      now: () => 100,
    })
    bridge = new SessionQueryBridge(queryClient, service, events)
    await bridge.getSession(session.id)
    const queuedMessage: Message = {
      id: 'queued-message',
      role: 'user',
      contentParts: [{ type: 'text', text: 'hello' }],
    }
    const metadataError = new Error('metadata update failed')
    vi.spyOn(repository.meta, 'update').mockRejectedValueOnce(metadataError)

    await expect(
      service.updateSessionWithMessages(session.id, (current) => {
        if (!current) throw new Error('Expected current session')
        return { ...current, messages: [...current.messages, queuedMessage] }
      })
    ).rejects.toBe(metadataError)

    expect(repository.sessions.get(session.id)?.messages).toEqual([queuedMessage])
    expect(queryClient.getQueryData<Session>(QueryKeys.ChatSession(session.id))?.messages).toEqual([queuedMessage])
    expect(repository.records.get(session.id)?.name).toBe(session.name)
  })

  test('bulk deletion resets every client from storage and includes unloaded pages', async () => {
    const repository = new MemorySessionRepository()
    for (let index = 1; index <= 4; index += 1) {
      const session = createTestSession(`session-${index}`)
      repository.sessions.set(session.id, session)
      repository.records.set(session.id, createTestRecord(session, index))
    }
    const events = new SessionEventBus()
    const service = createService(repository, events)
    const firstClient = new QueryClient()
    const secondClient = new QueryClient()
    const firstBridge = new SessionQueryBridge(firstClient, service, events)
    const secondBridge = new SessionQueryBridge(secondClient, service, events)

    await firstClient.fetchInfiniteQuery(firstBridge.definitions.sessions)
    await secondClient.fetchInfiniteQuery(secondBridge.definitions.sessions)
    expect(
      firstClient.getQueryData<InfiniteSessionData>(QueryKeys.ChatSessionsList)?.pages[0].items.map(({ id }) => id)
    ).toEqual(['session-4', 'session-3'])

    await service.deleteSessions(['session-3', 'session-1'])

    for (const client of [firstClient, secondClient]) {
      expect(client.getQueryData<InfiniteSessionData>(QueryKeys.ChatSessionsList)).toEqual({
        pages: [
          {
            items: [repository.records.get('session-4'), repository.records.get('session-2')],
            nextCursor: null,
            total: 2,
          },
        ],
        pageParams: [0],
      })
    }
    expect([...repository.sessions.keys()].sort()).toEqual(['session-2', 'session-4'])
  })

  test('metadata persistence preserves newer generating messages in the cache', async () => {
    const repository = new MemorySessionRepository()
    const events = new SessionEventBus()
    const service = createService(repository, events)
    const queryClient = new QueryClient()
    new SessionQueryBridge(queryClient, service, events)
    const persisted: Session = {
      ...createTestSession('session-1'),
      messages: [
        {
          id: 'assistant',
          role: 'assistant',
          contentParts: [{ type: 'text', text: 'old' }],
          generating: true,
        },
      ],
    }
    const cached: Session = {
      ...persisted,
      messages: [
        {
          ...persisted.messages[0],
          contentParts: [{ type: 'text', text: 'new streaming content' }],
        },
      ],
    }
    queryClient.setQueryData(QueryKeys.ChatSession(persisted.id), cached)

    await events.publish({
      type: 'session-updated',
      session: { ...persisted, name: 'Renamed' },
      meta: { id: persisted.id, name: 'Renamed', type: 'chat' },
      preserveCachedGeneratingMessages: true,
    })

    expect(queryClient.getQueryData<Session>(QueryKeys.ChatSession(persisted.id))).toMatchObject({
      name: 'Renamed',
      messages: [
        {
          contentParts: [{ type: 'text', text: 'new streaming content' }],
        },
      ],
    })
  })
})
