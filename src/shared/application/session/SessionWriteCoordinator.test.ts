import { describe, expect, test } from 'vitest'
import type { Message, Session } from '../../types'
import { createTestRecord, createTestSession, MemorySessionRepository } from './__tests__/memory-session-repository'
import { SessionWriteCoordinator } from './SessionWriteCoordinator'

function message(id: string): Message {
  return {
    id,
    role: 'assistant',
    contentParts: [{ type: 'text', text: id }],
    generating: true,
  }
}

function appendMessage(session: Session | null | undefined, messageId: string): Session {
  if (!session) throw new Error('Expected current session')
  return {
    ...session,
    messages: [...session.messages, message(messageId)],
  }
}

describe('SessionWriteCoordinator', () => {
  test('starts from the injected read model and serializes concurrent writes', async () => {
    const repository = new MemorySessionRepository()
    const persisted = createTestSession('session-1')
    const cached: Session = {
      ...persisted,
      messages: [message('streaming')],
    }
    repository.sessions.set(persisted.id, persisted)
    repository.records.set(persisted.id, createTestRecord(persisted, 1))
    const coordinator = new SessionWriteCoordinator(repository, {
      readCurrentSession: () => Promise.resolve(cached),
    })

    await Promise.all([
      coordinator.update(persisted.id, (session) => appendMessage(session, 'first')),
      coordinator.update(persisted.id, (session) => appendMessage(session, 'second')),
    ])

    expect(repository.sessions.get(persisted.id)?.messages.map(({ id }) => id)).toEqual([
      'streaming',
      'first',
      'second',
    ])
  })

  test('continues accepting writes after a rejected updater', async () => {
    const repository = new MemorySessionRepository()
    const session = createTestSession('session-1')
    repository.sessions.set(session.id, session)
    repository.records.set(session.id, createTestRecord(session, 1))
    const coordinator = new SessionWriteCoordinator(repository)

    await expect(
      coordinator.update(session.id, () => {
        throw new Error('rejected')
      })
    ).rejects.toThrow('rejected')

    await coordinator.update(session.id, { name: 'Recovered' })
    expect(repository.sessions.get(session.id)?.name).toBe('Recovered')
  })
})
