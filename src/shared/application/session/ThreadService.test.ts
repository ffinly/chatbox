import { describe, expect, test, vi } from 'vitest'
import type { AgentPromptSnapshot, Message, Session, Updater } from '../../types'
import type { SessionMetadataUpdate } from './session-metadata'
import type { SessionUseCasePort } from './session-use-case-port'
import { ThreadService } from './ThreadService'

function message(id: string, role: Message['role'], text = id): Message {
  return { id, role, contentParts: [{ type: 'text', text }] }
}

function personaSnapshot(soul: string): AgentPromptSnapshot {
  return {
    version: 1,
    soul,
    memories: [],
    workspaceInstructions: '',
    workspaceDirectories: [],
    capturedAt: 1,
    scope: 'agent',
  }
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
    const currentSnapshot = personaSnapshot('Current Soul')
    const historySnapshot = personaSnapshot('History Soul')
    const harness = createHarness({
      id: 'session-1',
      name: 'Session',
      threadName: 'Current thread',
      messages: current,
      settings: { agentPromptSnapshot: currentSnapshot },
      threads: [
        {
          id: 'history-1',
          name: 'History',
          messages: history,
          createdAt: 1,
          agentPromptSnapshot: historySnapshot,
        },
      ],
    })

    await expect(harness.service.switch('session-1', 'history-1')).resolves.toBe(true)

    expect(harness.cancelMessages).toHaveBeenCalledWith('session-1', current)
    expect(harness.session.messages).toBe(history)
    expect(harness.session.threadName).toBe('History')
    expect(harness.session.settings?.agentPromptSnapshot).toBe(historySnapshot)
    expect(harness.session.threads).toEqual([
      {
        id: 'thread-1',
        name: 'Current thread',
        messages: current,
        createdAt: 101,
        agentPromptSnapshot: currentSnapshot,
      },
    ])
  })

  test('creates a new thread with a clean system prompt and keeps existing history', async () => {
    const snapshot = personaSnapshot('Current Soul')
    const harness = createHarness({
      id: 'session-1',
      name: 'Session',
      messages: [message('system', 'system', 'Custom system'), message('user', 'user')],
      settings: { agentPromptSnapshot: snapshot },
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
    expect(harness.session.settings?.agentPromptSnapshot).toBeUndefined()
    expect(harness.session.threads?.at(-1)?.agentPromptSnapshot).toBe(snapshot)
  })

  test('compresses into a continuation prompt and clears fork state', async () => {
    const snapshot = personaSnapshot('Current Soul')
    const harness = createHarness({
      id: 'session-1',
      name: 'Session',
      messages: [message('system', 'system', 'System'), message('user', 'user')],
      settings: { agentPromptSnapshot: snapshot },
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
    expect(harness.session.settings?.agentPromptSnapshot).toBeUndefined()
    expect(harness.session.threads?.[0].agentPromptSnapshot).toBe(snapshot)
  })

  test('moves a history thread into a copied conversation before removing it', async () => {
    const historyMessages = [message('history', 'user')]
    const historySnapshot = personaSnapshot('History Soul')
    const harness = createHarness({
      id: 'session-1',
      name: 'Session',
      messages: [message('current', 'user')],
      settings: { agentPromptSnapshot: personaSnapshot('Current Soul') },
      threads: [
        {
          id: 'history-1',
          name: 'History',
          messages: historyMessages,
          createdAt: 1,
          agentPromptSnapshot: historySnapshot,
        },
      ],
    })

    await expect(harness.service.moveToConversation('session-1', 'history-1')).resolves.toBe('copied-session')

    expect(harness.copiedSource).toMatchObject({
      name: 'History',
      messages: historyMessages,
      threads: [],
      threadName: undefined,
      settings: { agentPromptSnapshot: historySnapshot },
    })
    expect(harness.session.threads).toEqual([])
    expect(harness.cancelMessages).toHaveBeenCalledWith('session-1', historyMessages)
  })

  test('cancels the messages discarded when removing the current thread', async () => {
    const currentMessages = [message('current', 'user'), message('reply', 'assistant')]
    const harness = createHarness({
      id: 'session-1',
      name: 'Session',
      messages: currentMessages,
      threads: [],
    })

    await expect(harness.service.removeCurrent('session-1')).resolves.toBe(true)

    expect(harness.cancelMessages).toHaveBeenCalledWith('session-1', currentMessages)
  })

  test('cancels inactive fork replies when replacing the current conversation', async () => {
    const pivot = message('pivot', 'user')
    const inactiveReply = message('inactive-reply', 'assistant')
    const harness = createHarness({
      id: 'session-1',
      name: 'Session',
      messages: [pivot],
      messageForksHash: {
        [pivot.id]: {
          position: 0,
          lists: [
            { id: 'current', messages: [] },
            { id: 'inactive', messages: [inactiveReply] },
          ],
          createdAt: 1,
        },
      },
    })

    await harness.service.refreshContextAndCreateNew('session-1')

    expect(harness.cancelMessages).toHaveBeenCalledWith('session-1', [pivot, inactiveReply])
  })
})
