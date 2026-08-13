// @vitest-environment jsdom

import { MantineProvider } from '@mantine/core'
import type { ChatboxAILicenseDetail, ChatboxAIPlanType, Message } from '@shared/types'
import { afterEach, expect, test, vi } from 'vitest'
import { settingsStore } from '@/stores/settingsStore'
import { fireEvent, render, screen } from '@/test-utils'
import MessageErrTips from './MessageErrTips'

const platformMocks = vi.hoisted(() => ({
  openLink: vi.fn(),
}))
const trackingMocks = vi.hoisted(() => ({
  trackTokenExhaustedCard: vi.fn(),
  trackTokenExhaustedCardClick: vi.fn(),
}))

vi.mock('@/platform', () => ({
  default: {
    type: 'desktop',
    isDesktopLike: true,
    openLink: platformMocks.openLink,
  },
}))

vi.mock('@/analytics/token-exhausted-card', () => ({
  trackTokenExhaustedCard: trackingMocks.trackTokenExhaustedCard,
  trackTokenExhaustedCardClick: trackingMocks.trackTokenExhaustedCardClick,
}))

Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn(
    (query: string): MediaQueryList => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(() => false),
    })
  ),
})

const initialSettings = settingsStore.getState()
const proPlusLicenseDetail: ChatboxAILicenseDetail = {
  name: 'Chatbox AI Pro+',
  plan: 'pro_plus',
  remaining_quota_35: 0,
  remaining_quota_4: 0,
  remaining_quota_image: 0,
  image_used_count: 0,
  image_total_quota: 0,
  plan_image_limit: 0,
  token_refreshed_time: '2026-08-12T00:00:00Z',
  remaining_quota_unified: 0,
  expansion_pack_limit: 0,
  expansion_pack_usage: 0,
  unified_token_usage: 0,
  unified_token_limit: 0,
  unified_token_usage_details: [],
  aggregated_reward_details: {
    type: 'reward',
    token_usage: 0,
    token_limit: 0,
    expires_at: null,
  },
}

afterEach(() => {
  platformMocks.openLink.mockReset()
  trackingMocks.trackTokenExhaustedCard.mockReset()
  trackingMocks.trackTokenExhaustedCardClick.mockReset()
  settingsStore.setState(initialSettings)
})

test.each([
  { name: 'paid quota for Pro', errorCode: 10004, plan: 'pro', agentMode: false, action: 'upgrade' },
  { name: 'paid quota for Pro+', errorCode: 10004, plan: 'pro_plus', agentMode: false, action: 'buy_token' },
  { name: 'Free quota', errorCode: 20039, plan: 'free', agentMode: false, action: 'upgrade' },
  { name: 'paid OCR quota for Pro', errorCode: 20041, plan: 'pro', agentMode: true, action: 'upgrade' },
  { name: 'paid OCR quota for Pro+', errorCode: 20041, plan: 'pro_plus', agentMode: true, action: 'buy_token' },
  { name: 'Free OCR quota', errorCode: 20042, plan: 'free', agentMode: true, action: 'upgrade' },
] as const)('tracks exposure and click for $name', ({ errorCode, plan, agentMode, action }) => {
  settingsStore.setState((state) => ({
    ...state,
    language: 'en',
    licenseKey: `${plan}-license`,
    licenseDetail:
      plan === 'free'
        ? undefined
        : {
            ...proPlusLicenseDetail,
            name: `Chatbox AI ${plan}`,
            plan: plan as ChatboxAIPlanType,
          },
  }))
  const msg = {
    id: 'assistant-error',
    role: 'assistant',
    contentParts: [],
    error: 'Token Quota Exhausted',
    errorCode,
    aiProvider: 'chatbox-ai',
    model: 'claude-opus-5',
    generationRequests: [{ agentMode }] as Message['generationRequests'],
  } as Message
  const expectedContext = {
    sessionId: 'session-123',
    mode: agentMode ? 'work_mode' : 'chat_mode',
    action,
    provider: 'chatbox-ai',
    plan,
    model: 'claude-opus-5',
  }

  render(
    <MantineProvider>
      <MessageErrTips msg={msg} sessionId="session-123" />
    </MantineProvider>
  )

  expect(trackingMocks.trackTokenExhaustedCard).toHaveBeenCalledOnce()
  expect(trackingMocks.trackTokenExhaustedCard).toHaveBeenCalledWith(expectedContext)

  fireEvent.click(screen.getByRole('button', { name: action === 'buy_token' ? 'Buy expansion pack' : 'Upgrade plan' }))

  expect(trackingMocks.trackTokenExhaustedCardClick).toHaveBeenCalledOnce()
  expect(trackingMocks.trackTokenExhaustedCardClick).toHaveBeenCalledWith(expectedContext)
  expect(platformMocks.openLink).toHaveBeenCalledWith(
    'https://chatboxai.app/redirect_app/view_more_plans/en?utm_source=app&utm_content=msg_quota_exhausted'
  )
})
