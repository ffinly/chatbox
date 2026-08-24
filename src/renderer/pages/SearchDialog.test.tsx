// @vitest-environment jsdom

import type { Message, Session } from '@shared/types'
import { MessageRoleEnum } from '@shared/types'
import type React from 'react'
import { describe, expect, test, vi } from 'vitest'
import { render } from '@/test-utils'

globalThis.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: vi.fn() },
  useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock('jotai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('jotai')>()),
  useAtomValue: () => undefined,
}))

vi.mock('@/hooks/useScreenChange', () => ({
  useIsSmallScreen: () => false,
}))

vi.mock('@/stores/uiStore', () => ({
  useUIStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      openSearchDialog: false,
      searchDialogGlobalOnly: false,
      setOpenSearchDialog: vi.fn(),
    }),
}))

vi.mock('@/stores/sessionHelpers', () => ({
  searchSessions: vi.fn(),
}))

vi.mock('@/stores/settingsStore', () => ({
  useSettingsStore: (selector: (state: { hideSystemPromptMessage: boolean }) => unknown) =>
    selector({ hideSystemPromptMessage: false }),
}))

vi.mock('../stores/scrollActions', () => ({
  scrollToMessage: vi.fn(),
}))

vi.mock('../stores/session/crud', () => ({
  switchCurrentSession: vi.fn(),
}))

vi.mock('@/components/chat/Message', () => ({
  default: () => null,
}))

vi.mock('@/components/Markdown', () => ({
  BlockCodeCollapsedStateProvider: ({ children }: { children: React.ReactNode }) => children,
}))

vi.mock('@/components/common/Mark', () => ({
  default: ({ children }: { children: React.ReactNode }) => children,
}))

import SearchDialog, { filterHiddenSystemPromptHits } from './SearchDialog'

function message(id: string, role: Message['role']): Message {
  return {
    id,
    role,
    contentParts: [{ type: 'text', text: `${id} text` }],
    timestamp: 1,
  }
}

function session(id: string, messages: Message[]): Session {
  return { id, type: 'chat', name: id, messages }
}

describe('SearchDialog', () => {
  test('does not hide the application from assistive technology while closed', () => {
    const appRoot = document.createElement('div')
    document.body.appendChild(appRoot)

    const { unmount } = render(<SearchDialog />, { container: appRoot })

    expect(appRoot.getAttribute('aria-hidden')).toBeNull()

    unmount()
    appRoot.remove()
  })
})

describe('filterHiddenSystemPromptHits', () => {
  const results = [
    session('only-system', [message('s1', MessageRoleEnum.System)]),
    session('mixed', [message('s2', MessageRoleEnum.System), message('u1', MessageRoleEnum.User)]),
  ]

  test('returns results untouched while the setting is off', () => {
    expect(filterHiddenSystemPromptHits(results, false)).toBe(results)
    expect(filterHiddenSystemPromptHits(results, undefined)).toBe(results)
  })

  test('drops system-prompt hits and sessions whose only hit was the system prompt', () => {
    const filtered = filterHiddenSystemPromptHits(results, true)
    expect(filtered.map((s) => s.id)).toEqual(['mixed'])
    expect(filtered[0].messages.map((m) => m.id)).toEqual(['u1'])
  })
})
