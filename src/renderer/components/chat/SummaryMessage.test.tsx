// @vitest-environment jsdom

import { MantineProvider } from '@mantine/core'
import type { Message } from '@shared/types'
import { fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, test, vi } from 'vitest'

const { showModalMock } = vi.hoisted(() => ({ showModalMock: vi.fn() }))

vi.mock('@ebay/nice-modal-react', () => ({ default: { show: showModalMock } }))
vi.mock('@/components/Markdown', () => ({ default: ({ children }: { children: ReactNode }) => <div>{children}</div> }))
vi.mock('@/components/ui/tooltip', () => ({
  AppTooltip: ({ label, children }: { label: ReactNode; children: ReactNode }) => (
    <span aria-label={String(label)}>{children}</span>
  ),
}))
vi.mock('@/lib/utils', () => ({
  cn: (...classes: (string | false | null | undefined)[]) => classes.filter(Boolean).join(' '),
}))
vi.mock('@/stores/settingsStore', () => ({
  useSettingsStore: (selector: (state: Record<string, boolean>) => boolean) =>
    selector({ enableMarkdownRendering: false, enableLaTeXRendering: false, enableMermaidRendering: false }),
}))
vi.mock('../common/ScalableIcon', () => ({ ScalableIcon: () => null }))
vi.mock('../layout/Overlay', () => ({
  Modal: ({ opened, children }: { opened: boolean; children: ReactNode }) => (opened ? <div>{children}</div> : null),
}))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

import SummaryMessage from './SummaryMessage'

const summary: Message = {
  id: 'summary-1',
  role: 'assistant',
  isSummary: true,
  contentParts: [{ type: 'text', text: 'compacted history' }],
}

function renderSummary(props: Partial<React.ComponentProps<typeof SummaryMessage>> = {}) {
  return render(
    <MantineProvider>
      <SummaryMessage msg={summary} sessionId="session-1" isLatestSummary onDelete={vi.fn()} {...props} />
    </MantineProvider>
  )
}

function expandSummary() {
  fireEvent.click(screen.getByText('Earlier messages summarized'))
}

describe('SummaryMessage mode policy', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    })
  })

  test('chat mode keeps the latest-summary edit and delete controls', () => {
    renderSummary()
    expandSummary()

    expect(screen.getByLabelText('Edit')).toBeTruthy()
    expect(screen.getByLabelText('Delete')).toBeTruthy()
  })

  test('work mode hides both summary controls (append-only policy)', () => {
    renderSummary({ sessionMode: 'work' })
    expandSummary()

    expect(screen.queryByLabelText('Edit')).toBeNull()
    expect(screen.queryByLabelText('Delete')).toBeNull()
  })

  test('without an onDelete callback only the edit control renders', () => {
    renderSummary({ onDelete: undefined })
    expandSummary()

    expect(screen.getByLabelText('Edit')).toBeTruthy()
    expect(screen.queryByLabelText('Delete')).toBeNull()
  })
})
