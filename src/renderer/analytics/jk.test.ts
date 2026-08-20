import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  track: vi.fn(),
  allowReportingAndTracking: true,
  language: 'zh-Hans',
}))

vi.mock('@ruguoapp/jk-analytics', () => ({
  config: vi.fn(),
  track: mocks.track,
}))

vi.mock('ua-parser-js', () => ({
  UAParser: () => ({
    browser: { name: 'Chrome', version: '120' },
    device: {},
    os: { name: 'macOS', version: '15' },
  }),
}))

vi.mock('@/packages/remote', () => ({ getUserProfile: vi.fn() }))
vi.mock('@/platform', () => ({
  default: {
    type: 'web',
    getVersion: vi.fn(),
    getPlatform: vi.fn(),
    getConfig: vi.fn(),
  },
}))
vi.mock('@/stores/authInfoStore', () => ({
  authInfoStore: {
    getState: () => ({ getTokens: () => null }),
    subscribe: vi.fn(),
  },
}))
vi.mock('@/stores/settingsStore', () => ({
  settingsStore: {
    getState: () => ({
      allowReportingAndTracking: mocks.allowReportingAndTracking,
      language: mocks.language,
    }),
  },
}))

import { trackJkAutoEvent } from './jk'

describe('JK analytics adapter', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.allowReportingAndTracking = true
    mocks.language = 'zh-Hans'
  })

  it('adds the shared event, web and user payload envelope', () => {
    trackJkAutoEvent('token_exhausted_card', {
      pageName: 'chat_page',
      content: 'pro_plus',
      contentType: 'claude-opus-5',
      props: {
        agent_info: { content: 'buy_token', mode: 'work_mode', session_id: 'session-1' },
      },
    })

    expect(mocks.track).toHaveBeenCalledWith(
      'token_exhausted_card',
      expect.objectContaining({
        event_info: { event: 'token_exhausted_card' },
        web_info: {
          action: 'AUTO',
          page_name: 'chat_page',
          platform: 'web',
          lang: 'zh-Hans',
        },
        content_info: { content: 'pro_plus', type: 'claude-opus-5' },
        user_info: { id: null },
        agent_info: { content: 'buy_token', mode: 'work_mode', session_id: 'session-1' },
      })
    )
  })

  it('does not send events when reporting and tracking is disabled', () => {
    mocks.allowReportingAndTracking = false

    trackJkAutoEvent('token_exhausted_card', { pageName: 'chat_page' })

    expect(mocks.track).not.toHaveBeenCalled()
  })
})
