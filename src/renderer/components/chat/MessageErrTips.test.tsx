// @vitest-environment jsdom

import { MantineProvider } from '@mantine/core'
import type { ChatboxAILicenseDetail, Message } from '@shared/types'
import { afterEach, expect, test, vi } from 'vitest'
import { settingsStore } from '@/stores/settingsStore'
import { fireEvent, render, screen } from '@/test-utils'
import MessageErrTips from './MessageErrTips'

const platformMocks = vi.hoisted(() => ({
  openLink: vi.fn(),
}))

vi.mock('@/platform', () => ({
  default: {
    type: 'desktop',
    isDesktopLike: true,
    openLink: platformMocks.openLink,
  },
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
  settingsStore.setState(initialSettings)
})

test('offers an expansion pack without changing the quota link for Pro+', () => {
  settingsStore.setState((state) => ({
    ...state,
    language: 'en',
    licenseKey: 'pro-plus-license',
    licenseDetail: proPlusLicenseDetail,
  }))
  const msg = {
    id: 'assistant-error',
    role: 'assistant',
    contentParts: [],
    error: 'Token Quota Exhausted',
    errorCode: 10004,
  } as Message

  expect(settingsStore.getState().licenseDetail?.plan).toBe('pro_plus')

  render(
    <MantineProvider>
      <MessageErrTips msg={msg} />
    </MantineProvider>
  )

  fireEvent.click(screen.getByRole('button', { name: 'Buy expansion pack' }))
  expect(platformMocks.openLink).toHaveBeenCalledWith(
    'https://chatboxai.app/redirect_app/view_more_plans/en?utm_source=app&utm_content=msg_quota_exhausted'
  )
})
