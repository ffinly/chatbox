import { beforeEach, describe, expect, it, vi } from 'vitest'
import { trackJkAutoEvent, trackJkClickEvent } from './jk'
import { JK_EVENTS, JK_PAGE_NAMES } from './jk-events'
import { trackTokenExhaustedCard, trackTokenExhaustedCardClick } from './token-exhausted-card'

vi.mock('@/platform', () => ({
  default: {
    type: 'desktop',
  },
}))

vi.mock('./jk', () => ({
  trackJkAutoEvent: vi.fn(),
  trackJkClickEvent: vi.fn(),
}))

const context = {
  sessionId: 'session-123',
  mode: 'work_mode' as const,
  action: 'buy_token' as const,
  provider: 'chatbox-ai',
  plan: 'pro_plus',
  model: 'claude-opus-5',
}

const expectedOptions = {
  pageName: JK_PAGE_NAMES.CHAT_PAGE,
  platform: 'app',
  content: 'pro_plus',
  contentType: 'claude-opus-5',
  props: {
    agent_info: {
      content: 'buy_token',
      mode: 'work_mode',
      session_id: 'session-123',
    },
    content_add_info: {
      content: 'chatbox-ai',
    },
  },
}

describe('token exhausted card tracking', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('tracks card exposure with AUTO and the complete card context', () => {
    trackTokenExhaustedCard(context)

    expect(trackJkAutoEvent).toHaveBeenCalledWith(JK_EVENTS.TOKEN_EXHAUSTED_CARD, expectedOptions)
  })

  it('tracks CTA clicks with CLICK and the same card context', () => {
    trackTokenExhaustedCardClick(context)

    expect(trackJkClickEvent).toHaveBeenCalledWith(JK_EVENTS.TOKEN_EXHAUSTED_CARD_CLICK, expectedOptions)
  })
})
