import { beforeEach, describe, expect, it, vi } from 'vitest'

const { disableToolCallLimitPauseAndContinueMock } = vi.hoisted(() => ({
  disableToolCallLimitPauseAndContinueMock: vi.fn(),
}))

vi.mock('@/adapters/CurrentGenerationService', () => ({
  currentGenerationService: {
    disableToolCallLimitPauseAndContinue: disableToolCallLimitPauseAndContinueMock,
  },
}))

import { disableToolCallLimitPauseAndContinue } from './orchestration'

describe('disableToolCallLimitPauseAndContinue compatibility facade', () => {
  beforeEach(() => {
    disableToolCallLimitPauseAndContinueMock.mockReset()
  })

  it('delegates to the shared generation service', async () => {
    disableToolCallLimitPauseAndContinueMock.mockResolvedValue(undefined)

    await disableToolCallLimitPauseAndContinue('session-1', 'message-1', 'tool-1', 'global')

    expect(disableToolCallLimitPauseAndContinueMock).toHaveBeenCalledWith(
      'session-1',
      'message-1',
      'tool-1',
      'global'
    )
  })
})
