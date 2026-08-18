import { describe, expect, it } from 'vitest'
import type { Message, Session } from '../types'
import {
  backfillMissingThreadName,
  DEFAULT_INBOX_SESSION_ID,
  resolveAutoTitleAction,
  sanitizeGeneratedSessionName,
  shouldBackfillThreadName,
} from './auto-title'

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
    type: 'chat',
    messages: [],
    ...overrides,
  }
}

const firstTurn = [message('user', 'hello'), message('assistant', 'hi', { finishReason: 'stop' })]

describe('sanitizeGeneratedSessionName', () => {
  it('strips quotes and multiline think blocks', () => {
    expect(sanitizeGeneratedSessionName('"北京旅行计划"')).toBe('北京旅行计划')
    expect(sanitizeGeneratedSessionName('<think>\nreasoning\nmore\n</think>\n周末计划')).toBe('周末计划')
  })

  it('returns empty when only a think block remains', () => {
    expect(sanitizeGeneratedSessionName('<think>\nonly thinking\n</think>')).toBe('')
  })
})

describe('threadName backfill', () => {
  it('copies name onto historical sessions that never had threadName', () => {
    const named = session({ name: '北京旅行计划', messages: firstTurn })
    expect(shouldBackfillThreadName(named)).toBe(true)
    expect(backfillMissingThreadName(named)).toEqual({
      session: { ...named, threadName: '北京旅行计划' },
      changed: true,
    })
  })

  it('does not backfill Untitled, inbox, or an already present field', () => {
    expect(shouldBackfillThreadName(session({ messages: firstTurn }))).toBe(false)
    expect(
      shouldBackfillThreadName(
        session({
          id: DEFAULT_INBOX_SESSION_ID,
          name: 'Just chat',
          messages: firstTurn,
        })
      )
    ).toBe(false)
    expect(shouldBackfillThreadName(session({ name: 'Named', threadName: '' }))).toBe(false)
    expect(shouldBackfillThreadName(session({ name: 'Named', threadName: 'Thread' }))).toBe(false)
  })

  it('restores pending instead of the old name when there is no title-worthy content', () => {
    // Cleared under the old semantics (undefined meant "pending") or never
    // chatted in: the next conversation must still get first-reply AI naming.
    const cleared = session({ name: '北京旅行计划', messages: [message('system', 'You are helpful')] })
    expect(shouldBackfillThreadName(cleared)).toBe(true)
    expect(backfillMissingThreadName(cleared)).toEqual({
      session: { ...cleared, threadName: '' },
      changed: true,
    })
  })

  it('does not treat a newly created named session as historical', () => {
    expect(shouldBackfillThreadName(session({ name: 'Travel planner', threadName: '' }))).toBe(false)
    expect(backfillMissingThreadName(session({ name: 'Travel planner', threadName: '', messages: firstTurn }))).toEqual(
      {
        session: session({ name: 'Travel planner', threadName: '', messages: firstTurn }),
        changed: false,
      }
    )
  })
})

describe('resolveAutoTitleAction', () => {
  it('names Untitled sessions after the first successful reply', () => {
    expect(resolveAutoTitleAction(session({ messages: firstTurn }))).toBe('session-and-thread')
  })

  it('names a pending thread without copying a historical title', () => {
    expect(
      resolveAutoTitleAction(
        session({
          name: 'Existing title',
          threadName: '',
          messages: firstTurn,
        })
      )
    ).toBe('thread')
  })

  it('names the thread of a newly created named session after the first reply', () => {
    expect(
      resolveAutoTitleAction(
        session({
          name: 'Travel planner',
          threadName: '',
          messages: firstTurn,
        })
      )
    ).toBe('thread')
  })

  it('leaves historical missing threadName to backfill instead of the model', () => {
    expect(
      resolveAutoTitleAction(
        session({
          name: '北京旅行计划',
          messages: firstTurn,
        })
      )
    ).toBeNull()
  })

  it('still names the inbox conversation', () => {
    expect(
      resolveAutoTitleAction(
        session({
          id: DEFAULT_INBOX_SESSION_ID,
          name: 'Just chat',
          messages: firstTurn,
        })
      )
    ).toBe('thread')
  })

  it('does nothing when both titles exist', () => {
    expect(
      resolveAutoTitleAction(
        session({
          name: 'Existing title',
          threadName: 'Existing thread',
          messages: firstTurn,
        })
      )
    ).toBeNull()
  })
})
