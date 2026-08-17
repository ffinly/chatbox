// @vitest-environment jsdom

import { ModelProviderEnum } from '@shared/types'
import { beforeEach, describe, expect, test, vi } from 'vitest'

vi.mock('@/platform', () => ({ default: { type: 'web' } }))

import { uiStore } from '../uiStore'
import { resolveWebBrowsingMode } from './web-browsing'

beforeEach(() => {
  uiStore.setState({
    sessionWebBrowsingMap: {},
    newSessionWebBrowsingDefault: undefined,
    currentWebBrowsingDisplay: { sessionId: '', value: false },
  })
})

describe('resolveWebBrowsingMode', () => {
  test('uses the remembered default for a new chat', () => {
    expect(resolveWebBrowsingMode('new', 'openai', {}, true)).toBe(true)
    expect(resolveWebBrowsingMode('new', ModelProviderEnum.ChatboxAI, {}, false)).toBe(false)
  })

  test('prefers a transient new-chat selection over the remembered default', () => {
    expect(resolveWebBrowsingMode('new', ModelProviderEnum.ChatboxAI, { new: false }, true)).toBe(false)
  })

  test('does not apply the remembered default to existing sessions without an explicit value', () => {
    expect(resolveWebBrowsingMode('legacy-session', 'openai', {}, true)).toBe(false)
    expect(resolveWebBrowsingMode('legacy-session', ModelProviderEnum.ChatboxAI, {}, false)).toBe(true)
  })

  test('keeps the provider defaults until the user has chosen a new-chat default', () => {
    expect(resolveWebBrowsingMode('new', ModelProviderEnum.ChatboxAI, {}, undefined)).toBe(true)
    expect(resolveWebBrowsingMode('new', 'openai', {}, undefined)).toBe(false)
  })
})

describe('new-chat Web Search preference', () => {
  test('remembers an explicit selection made in a new chat', () => {
    uiStore.getState().setSessionWebBrowsing('new', true)

    expect(uiStore.getState().newSessionWebBrowsingDefault).toBe(true)
  })

  test('keeps the remembered default after the transient new-chat state is cleared', () => {
    uiStore.getState().setSessionWebBrowsing('new', true)
    uiStore.getState().clearSessionWebBrowsing('new')

    const state = uiStore.getState()
    expect(state.sessionWebBrowsingMap.new).toBeUndefined()
    expect(
      resolveWebBrowsingMode('new', 'openai', state.sessionWebBrowsingMap, state.newSessionWebBrowsingDefault)
    ).toBe(true)
  })

  test('does not replace the new-chat default when changing an existing session', () => {
    uiStore.setState({ newSessionWebBrowsingDefault: true })

    uiStore.getState().setSessionWebBrowsing('session-1', false)

    expect(uiStore.getState().newSessionWebBrowsingDefault).toBe(true)
  })

  test('remembers keyboard shortcut changes made in a new chat', () => {
    uiStore.setState({ currentWebBrowsingDisplay: { sessionId: 'new', value: false } })

    uiStore.getState().toggleSessionWebBrowsing('new')

    expect(uiStore.getState().newSessionWebBrowsingDefault).toBe(true)
  })
})
