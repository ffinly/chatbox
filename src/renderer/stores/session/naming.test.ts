import type { Message } from '@shared/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  scheduleNameAndThreadName: vi.fn(),
  scheduleThreadName: vi.fn(),
  clearSessionState: vi.fn(),
}))

vi.mock('@chatbox/core/application/session', () => ({
  SessionNamingService: class {
    scheduleNameAndThreadName = mocks.scheduleNameAndThreadName
    scheduleThreadName = mocks.scheduleThreadName
    clearSessionState = mocks.clearSessionState
    modifyNameAndThreadName = vi.fn()
    modifyThreadName = vi.fn()
  },
}))

vi.mock('@/adapters/CurrentModelFactory', () => ({ currentModelFactory: {} }))
vi.mock('@/packages/model-calls/message-utils', () => ({ convertToModelMessages: vi.fn() }))
vi.mock('@/settings-runtime', () => ({ settingsService: {} }))
vi.mock('@/utils/sentry', () => ({ reportError: vi.fn() }))
vi.mock('../chatStore', () => ({ getSession: vi.fn(), updateSession: vi.fn() }))

import {
  clearSessionNameGenerationState,
  scheduleGenerateNameAndThreadName,
  scheduleGenerateThreadName,
} from './naming'

describe('Session naming Renderer adapter', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('forwards current messages to the shared naming scheduler', () => {
    const messages: Message[] = [{ id: 'user', role: 'user', contentParts: [{ type: 'text', text: 'hello' }] }]

    scheduleGenerateNameAndThreadName('session-1', { messages })
    scheduleGenerateThreadName('session-1', { messages })

    expect(mocks.scheduleNameAndThreadName).toHaveBeenCalledWith('session-1', { messages })
    expect(mocks.scheduleThreadName).toHaveBeenCalledWith('session-1', { messages })
  })

  it('delegates deletion cleanup to the shared naming service', () => {
    clearSessionNameGenerationState('session-1')

    expect(mocks.clearSessionState).toHaveBeenCalledWith('session-1')
  })
})
