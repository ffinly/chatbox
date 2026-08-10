import type { Message, Session } from '@shared/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { getSessionMock, toastMock } = vi.hoisted(() => ({
  getSessionMock: vi.fn(),
  toastMock: vi.fn(),
}))

vi.mock('../chatStore', () => ({ getSession: getSessionMock }))
vi.mock('../toastActions', () => ({ add: toastMock }))
vi.mock('i18next', () => ({ t: (key: string) => key }))

import { setCompactionUIState } from '../atoms/compactionAtoms'
import { guardSessionAction } from './action-guard'

function message(overrides: Partial<Message>): Message {
  return {
    id: overrides.id ?? 'message-id',
    role: overrides.role ?? 'assistant',
    contentParts: overrides.contentParts ?? [],
    ...overrides,
  }
}

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: 'session-1',
    name: 'Session',
    messages: [message({ id: 'user', role: 'user' })],
    ...overrides,
  }
}

describe('guardSessionAction', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setCompactionUIState('session-1', { status: 'idle' })
  })

  it('allows the action and stays silent when the session is unlocked', async () => {
    getSessionMock.mockResolvedValue(session())

    await expect(guardSessionAction('session-1', 'switch-fork')).resolves.toBe(true)
    expect(toastMock).not.toHaveBeenCalled()
  })

  it('blocks regenerate-class actions and toasts while a reply streams', async () => {
    getSessionMock.mockResolvedValue(
      session({
        messages: [message({ id: 'user', role: 'user' }), message({ id: 'reply', generating: true, cancel: () => {} })],
      })
    )

    await expect(guardSessionAction('session-1', 'regenerate')).resolves.toBe(false)
    expect(toastMock).toHaveBeenCalledWith('Wait for the current replies to finish', 2500)
  })

  it('blocks fork switching while compaction runs for this session', async () => {
    getSessionMock.mockResolvedValue(session())
    setCompactionUIState('session-1', { status: 'running' })

    await expect(guardSessionAction('session-1', 'switch-fork')).resolves.toBe(false)
    expect(toastMock).toHaveBeenCalledWith('Wait for compaction to finish', 2500)
  })

  it('blocks mutations in legacy picture sessions but still allows branch navigation', async () => {
    getSessionMock.mockResolvedValue(session({ type: 'picture' }))

    await expect(guardSessionAction('session-1', 'regenerate')).resolves.toBe(false)
    expect(toastMock).toHaveBeenCalledWith('This session is read-only', 2500)

    toastMock.mockClear()
    await expect(guardSessionAction('session-1', 'switch-fork')).resolves.toBe(true)
    expect(toastMock).not.toHaveBeenCalled()
  })

  it('lets the action surface its own handling when the session is missing', async () => {
    getSessionMock.mockResolvedValue(null)

    await expect(guardSessionAction('missing', 'submit-message')).resolves.toBe(true)
    expect(toastMock).not.toHaveBeenCalled()
  })
})
