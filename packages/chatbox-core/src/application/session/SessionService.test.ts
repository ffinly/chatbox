import { describe, expect, test, vi } from 'vitest'
import { createTestRecord, createTestSession, MemorySessionRepository } from './__tests__/memory-session-repository'
import { SessionService } from './SessionService'
import { SessionNotFoundError, SessionWriteCoordinator } from './SessionWriteCoordinator'
import { type SessionApplicationEvent, SessionEventBus } from './session-events'

function createHarness(
  repairSessionOnRead?: (session: ReturnType<typeof createTestSession>) => {
    session: ReturnType<typeof createTestSession>
    changed: boolean
  }
) {
  const repository = new MemorySessionRepository()
  const events = new SessionEventBus()
  const published: SessionApplicationEvent[] = []
  events.subscribe((event) => {
    published.push(event)
  })
  const writes = new SessionWriteCoordinator(repository)
  const log = vi.fn()
  const service = new SessionService(repository, writes, events, {
    createId: () => 'created-session',
    logger: { log },
    now: () => 100,
    getLastUsedModels: () => ({
      chat: { provider: 'openai', modelId: 'last-used-model' },
    }),
    repairSessionOnRead,
  })
  return { repository, events, log, published, service }
}

describe('SessionService', () => {
  test('logs session read failures before rethrowing the repository error', async () => {
    const harness = createHarness()
    const error = new Error('read failed')
    vi.spyOn(harness.repository, 'getSession').mockRejectedValue(error)

    await expect(harness.service.getSession('session-1')).rejects.toBe(error)
    expect(harness.log).toHaveBeenCalledWith(
      'error',
      'Failed to read session from repository',
      expect.objectContaining({
        sessionId: 'session-1',
        error: expect.objectContaining({ name: 'Error', message: 'read failed' }),
      })
    )
  })

  test('logs session-list page read failures before rethrowing', async () => {
    const harness = createHarness()
    const error = new Error('page failed')
    vi.spyOn(harness.repository.meta, 'getPage').mockRejectedValue(error)

    await expect(harness.service.listSessionsMetaPage(20, 10)).rejects.toBe(error)
    expect(harness.log).toHaveBeenCalledWith(
      'error',
      'Failed to read session list page from repository',
      expect.objectContaining({ cursor: 20, limit: 10 })
    )
  })

  test('persists read repairs through the write coordinator and publishes the repaired session', async () => {
    const harness = createHarness((session) => ({
      session: session.name === 'Recovered' ? session : { ...session, name: 'Recovered' },
      changed: session.name !== 'Recovered',
    }))
    const persisted = createTestSession('session-1')
    harness.repository.sessions.set(persisted.id, persisted)
    const setSession = vi.spyOn(harness.repository, 'setSession')

    await expect(harness.service.getSession(persisted.id)).resolves.toMatchObject({ name: 'Recovered' })

    expect(setSession).toHaveBeenCalledOnce()
    expect(harness.repository.sessions.get(persisted.id)?.name).toBe('Recovered')
    expect(harness.published.at(-1)).toMatchObject({
      type: 'session-updated',
      session: { id: persisted.id, name: 'Recovered' },
      meta: null,
      preserveCachedGeneratingMessages: true,
    })

    await harness.service.getSession(persisted.id)
    expect(setSession).toHaveBeenCalledOnce()
  })

  test('logs each unreadable session and a recovery summary', async () => {
    const harness = createHarness()
    const readable = createTestSession('readable')
    vi.spyOn(harness.repository, 'getAllSessionIds').mockResolvedValue(['unreadable', 'readable'])
    vi.spyOn(harness.repository, 'getSession').mockImplementation((sessionId) => {
      if (sessionId === 'unreadable') return Promise.reject(new Error('large IndexedDB value'))
      return Promise.resolve(readable)
    })

    await expect(harness.service.recoverSessionList()).resolves.toEqual({ recovered: 1, failed: 1 })
    expect(harness.log).toHaveBeenCalledWith(
      'error',
      'Failed to read session during session-list recovery',
      expect.objectContaining({ sessionId: 'unreadable' })
    )
    expect(harness.log).toHaveBeenCalledWith('warn', 'Failed to recover sessions due to read errors', {
      failed: 1,
      sessionIds: ['unreadable'],
    })
  })

  test('creates full session data and meta before publishing a precise event', async () => {
    const harness = createHarness()

    const created = await harness.service.createSession({
      name: 'Created',
      type: 'chat',
      messages: [],
      settings: { temperature: 0.3 },
    })

    expect(created.threadName).toBe('')
    expect(created.settings).toEqual({
      provider: 'openai',
      modelId: 'last-used-model',
      temperature: 0.3,
    })
    expect(harness.repository.sessions.get(created.id)).toBe(created)
    expect(harness.repository.records.get(created.id)).toMatchObject({
      id: created.id,
      sortOrder: 100,
      createdAt: 100,
    })
    expect(harness.published.at(-1)).toMatchObject({ type: 'session-created', session: created })
  })

  test('keeps an explicit thread title on create instead of marking the session pending', async () => {
    const harness = createHarness()

    const created = await harness.service.createSession({
      name: 'Weekend trip',
      type: 'chat',
      threadName: 'Weekend trip',
      messages: [],
    })

    expect(created.threadName).toBe('Weekend trip')
  })

  test('does not report a committed create as failed when a post-event listener rejects', async () => {
    const harness = createHarness()
    harness.events.subscribe((event) => {
      if (event.type === 'session-created') {
        return Promise.reject(new Error('subscriber failed'))
      }
    })

    const created = await harness.service.createSession({
      name: 'Created',
      type: 'chat',
      messages: [],
      settings: {},
    })

    expect(harness.repository.sessions.get(created.id)).toBe(created)
    expect(harness.repository.records.has(created.id)).toBe(true)
  })

  test('archives and restores full data and meta together', async () => {
    const harness = createHarness()
    const session = createTestSession('session-1')
    harness.repository.sessions.set(session.id, session)
    harness.repository.records.set(session.id, createTestRecord(session, 1))

    await harness.service.archiveSession(session.id)
    expect(harness.repository.sessions.get(session.id)).toMatchObject({ hidden: true, archivedAt: 100 })
    expect(harness.repository.records.get(session.id)).toMatchObject({ hidden: true, archivedAt: 100 })

    await harness.service.restoreSession(session.id)
    expect(harness.repository.sessions.get(session.id)?.hidden).toBe(false)
    expect(harness.repository.sessions.get(session.id)?.archivedAt).toBeUndefined()
    expect(harness.repository.records.get(session.id)?.hidden).toBe(false)
    expect(harness.repository.records.get(session.id)?.archivedAt).toBeUndefined()
  })

  test('deletes persistence only after awaited pre-delete effects', async () => {
    const harness = createHarness()
    const session = createTestSession('session-1')
    harness.repository.sessions.set(session.id, session)
    harness.repository.records.set(session.id, createTestRecord(session, 1))
    const order: string[] = []
    harness.events.subscribe((event) => {
      if (event.type === 'session-will-delete') {
        throw new Error('best-effort cleanup failed')
      }
    })
    harness.events.subscribe(async (event) => {
      if (event.type === 'session-will-delete') {
        await Promise.resolve()
        order.push('effect')
      }
      if (event.type === 'session-deleted') {
        order.push('deleted')
      }
    })
    const deleteSpy = vi.spyOn(harness.repository, 'deleteSession').mockImplementation((id) => {
      order.push('storage')
      harness.repository.sessions.delete(id)
      return Promise.resolve()
    })

    await harness.service.deleteSession(session.id)

    expect(deleteSpy).toHaveBeenCalledWith(session.id)
    expect(order).toEqual(['effect', 'storage', 'deleted'])
    expect(harness.repository.records.has(session.id)).toBe(false)
  })

  test('rejects writes that start after deletion begins and never resurrects the session', async () => {
    const harness = createHarness()
    const session = createTestSession('session-1')
    harness.repository.sessions.set(session.id, session)
    harness.repository.records.set(session.id, createTestRecord(session, 1))
    let releasePreDelete: () => void = () => undefined
    const preDeleteBlocked = new Promise<void>((resolve) => {
      releasePreDelete = resolve
    })
    let preDeleteStarted: () => void = () => undefined
    const preDeleteStartedPromise = new Promise<void>((resolve) => {
      preDeleteStarted = resolve
    })
    harness.events.subscribe(async (event) => {
      if (event.type !== 'session-will-delete') return
      preDeleteStarted()
      await preDeleteBlocked
    })

    const deletion = harness.service.deleteSession(session.id)
    await preDeleteStartedPromise

    await expect(harness.service.updateSession(session.id, { name: 'late write' })).rejects.toBeInstanceOf(
      SessionNotFoundError
    )
    releasePreDelete()
    await deletion

    expect(harness.repository.sessions.has(session.id)).toBe(false)
    expect(harness.repository.records.has(session.id)).toBe(false)
  })

  test('does not resurrect a session when metadata deletion fails after full-session deletion', async () => {
    const harness = createHarness()
    const session = createTestSession('session-1')
    harness.repository.sessions.set(session.id, session)
    harness.repository.records.set(session.id, createTestRecord(session, 1))
    await harness.service.updateSession(session.id, { name: 'Cached before delete' })
    vi.spyOn(harness.repository.meta, 'delete').mockRejectedValueOnce(new Error('metadata deletion failed'))

    await expect(harness.service.deleteSession(session.id)).rejects.toThrow('metadata deletion failed')
    await expect(harness.service.updateSession(session.id, { name: 'Must not revive' })).rejects.toBeInstanceOf(
      SessionNotFoundError
    )

    expect(harness.repository.sessions.has(session.id)).toBe(false)
    expect(harness.repository.records.has(session.id)).toBe(true)
  })

  test('keeps writes fenced until every started bulk deletion settles', async () => {
    const harness = createHarness()
    const failed = createTestSession('failed')
    const delayed = createTestSession('delayed')
    for (const session of [failed, delayed]) {
      harness.repository.sessions.set(session.id, session)
      harness.repository.records.set(session.id, createTestRecord(session, 1))
      await harness.service.updateSession(session.id, { name: `Cached ${session.id}` })
    }

    let releaseDelayedDelete: () => void = () => undefined
    const delayedDeleteBlocked = new Promise<void>((resolve) => {
      releaseDelayedDelete = resolve
    })
    let delayedDeleteStarted: () => void = () => undefined
    const delayedDeleteStartedPromise = new Promise<void>((resolve) => {
      delayedDeleteStarted = resolve
    })
    const originalDeleteSession = harness.repository.deleteSession.bind(harness.repository)
    vi.spyOn(harness.repository, 'deleteSession').mockImplementation(async (sessionId) => {
      if (sessionId === failed.id) throw new Error('bulk deletion failed')
      delayedDeleteStarted()
      await delayedDeleteBlocked
      await originalDeleteSession(sessionId)
    })

    const deletionResult = harness.service.deleteSessions([failed.id, delayed.id]).then(
      () => undefined,
      (error: unknown) => error
    )
    await delayedDeleteStartedPromise
    await Promise.resolve()
    await Promise.resolve()

    await expect(harness.service.updateSession(delayed.id, { name: 'Must remain fenced' })).rejects.toBeInstanceOf(
      SessionNotFoundError
    )
    releaseDelayedDelete()

    await expect(deletionResult).resolves.toEqual(expect.objectContaining({ message: 'bulk deletion failed' }))
    expect(harness.repository.sessions.has(delayed.id)).toBe(false)
  })
})
