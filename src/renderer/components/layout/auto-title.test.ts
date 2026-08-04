import type { Message, Session } from '@shared/types'
import { describe, expect, it, vi } from 'vitest'
import { getAutoTitleGenerationAction } from './auto-title'

vi.mock('@/stores/session', async () => vi.importActual('@/stores/session/message-success'))

function message(role: Message['role'], text: string, overrides: Partial<Message> = {}): Message {
  return {
    id: `${role}-${text}`,
    role,
    contentParts: text ? [{ type: 'text', text }] : [],
    ...overrides,
  }
}

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: 'session-1',
    name: 'Untitled',
    messages: [],
    ...overrides,
  }
}

describe('automatic title generation', () => {
  it('waits for a successful user-visible assistant reply', () => {
    const user = message('user', 'hello')

    expect(
      getAutoTitleGenerationAction(
        session({ messages: [user, message('assistant', '', { error: 'failed', finishReason: 'error' })] })
      )
    ).toBeNull()
    expect(
      getAutoTitleGenerationAction(
        session({ messages: [user, message('assistant', '', { finishReason: 'canceled' })] })
      )
    ).toBeNull()
    expect(
      getAutoTitleGenerationAction(session({ messages: [user, message('assistant', '', { finishReason: 'stop' })] }))
    ).toBeNull()
  })

  it('generates the session and thread title after the first successful reply', () => {
    expect(
      getAutoTitleGenerationAction(
        session({
          messages: [message('user', 'hello'), message('assistant', 'hi', { finishReason: 'stop' })],
        })
      )
    ).toBe('session-and-thread')
  })

  it('generates a title while the first agent-mode reply is still generating', () => {
    expect(
      getAutoTitleGenerationAction(
        session({
          messages: [message('user', 'refactor the auth module'), message('assistant', '', { generating: true })],
        })
      )
    ).toBe('session-and-thread')
  })

  it('generates a title from an earlier successful turn even if a later reply is still generating', () => {
    expect(
      getAutoTitleGenerationAction(
        session({
          messages: [
            message('user', 'hello'),
            message('assistant', 'hi', { finishReason: 'stop' }),
            message('user', 'follow-up'),
            message('assistant', 'partial reply', { generating: true }),
          ],
        })
      )
    ).toBe('session-and-thread')
  })

  it('generates only a missing thread title for an already named session', () => {
    expect(
      getAutoTitleGenerationAction(
        session({
          name: 'Existing title',
          threadName: '',
          messages: [message('user', 'hello'), message('assistant', 'hi', { finishReason: 'stop' })],
        })
      )
    ).toBe('thread')
  })

  it('does nothing when both titles already exist', () => {
    expect(
      getAutoTitleGenerationAction(
        session({
          name: 'Existing title',
          threadName: 'Existing thread',
          messages: [message('user', 'hello'), message('assistant', 'hi', { finishReason: 'stop' })],
        })
      )
    ).toBeNull()
  })
})
