import { describe, expect, test, vi } from 'vitest'
import type { Message, Session, Updater } from '../../types'
import type { SessionMetadataUpdate } from './session-metadata'
import type { SessionUseCasePort } from './session-use-case-port'
import { ThreadService } from './ThreadService'

function message(id: string, role: Message['role'], text = id): Message {
  return { id, role, contentParts: [{ type: 'text', text }] }
}

function createHarness(initial: Session) {
  let session = initial
  let copiedSource: Session | undefined
  let id = 0
  const sessions: SessionUseCasePort = {
    getSession: () => Promise.resolve(session),
    async updateSession(_sessionId, updater: Updater<SessionMetadataUpdate>) {
      const update = typeof updater === 'function' ? updater(session) : updater
      session = { ...session, ...update }
      return session
    },
    async updateSessionWithMessages(_sessionId, updater) {
      session = typeof updater === 'function' ? updater(session) : { ...session, ...updater }
      return session
    },
  }
  const cancelMessages = vi.fn()
  const service = new ThreadService({
    sessions,
    createId: () => `thread-${++id}`,
    now: () => 100 + id,
    getDefaultSystemPrompt: () => 'Default system',
    cancelMessages,
    copySession: async (source) => {
      copiedSource = source
      return { ...source, id: 'copied-session' }
    },
  })
  return {
    service,
    cancelMessages,
    get session() {
      return session
    },
    get copiedSource() {
      return copiedSource
    },
  }
}

describe('ThreadService', () => {
  test('switches thread data while returning UI effects to the host', async () => {
    const current = [message('system', 'system'), message('current', 'user')]
    const history = [message('history', 'user')]
    const harness = createHarness({
      id: 'session-1',
      name: 'Session',
      threadName: 'Current thread',
      messages: current,
      threads: [{ id: 'history-1', name: 'History', messages: history, createdAt: 1 }],
    })

    await expect(harness.service.switch('session-1', 'history-1')).resolves.toBe(true)

    expect(harness.cancelMessages).toHaveBeenCalledWith('session-1', current)
    expect(harness.session.messages).toBe(history)
    expect(harness.session.threadName).toBe('History')
    expect(harness.session.threads).toEqual([
      { id: 'thread-1', name: 'Current thread', messages: current, createdAt: 101 },
    ])
  })

  test('creates a new thread with a clean system prompt and keeps existing history', async () => {
    const harness = createHarness({
      id: 'session-1',
      name: 'Session',
      messages: [message('system', 'system', 'Custom system'), message('user', 'user')],
      threads: [{ id: 'old', name: 'Old', messages: [], createdAt: 1 }],
    })

    await harness.service.refreshContextAndCreateNew('session-1')

    expect(harness.session.threads).toHaveLength(2)
    expect(harness.session.messages).toHaveLength(1)
    expect(harness.session.messages[0]).toMatchObject({
      role: 'system',
      contentParts: [{ type: 'text', text: 'Custom system' }],
    })
    expect(harness.session.threadName).toBe('')
  })

  test('compresses into a continuation prompt and clears fork state', async () => {
    const harness = createHarness({
      id: 'session-1',
      name: 'Session',
      messages: [message('system', 'system', 'System'), message('user', 'user')],
      messageForksHash: {
        user: { position: 0, lists: [{ id: 'branch', messages: [] }], createdAt: 1 },
      },
    })

    await harness.service.compressAndCreate('session-1', 'Summary')

    expect(harness.session.messages.map(({ role }) => role)).toEqual(['system', 'user'])
    expect(harness.session.messages[1].contentParts).toEqual([
      { type: 'text', text: 'Previous conversation summary:\n\nSummary' },
    ])
    expect(harness.session.messageForksHash).toBeUndefined()
    expect(harness.session.threads).toHaveLength(1)
  })

  test('moves a history thread into a copied conversation before removing it', async () => {
    const historyMessages = [message('history', 'user')]
    const harness = createHarness({
      id: 'session-1',
      name: 'Session',
      messages: [message('current', 'user')],
      threads: [{ id: 'history-1', name: 'History', messages: historyMessages, createdAt: 1 }],
    })

    await expect(harness.service.moveToConversation('session-1', 'history-1')).resolves.toBe('copied-session')

    expect(harness.copiedSource).toMatchObject({
      name: 'History',
      messages: historyMessages,
      threads: [],
      threadName: undefined,
    })
    expect(harness.session.threads).toEqual([])
  })
})
