import type { ExportChatFormat, Session } from '@shared/types'
import { createMessage } from '@shared/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockGetSession, mockExportTextFile, mockFormatHtml, mockFormatMarkdown, mockFormatTxt } = vi.hoisted(() => ({
  mockGetSession: vi.fn(),
  mockExportTextFile: vi.fn(),
  mockFormatHtml: vi.fn(async () => '<html></html>'),
  mockFormatMarkdown: vi.fn(() => '# export'),
  mockFormatTxt: vi.fn(() => 'export'),
}))

vi.mock('@/app/renderer-application', () => ({
  rendererApplication: { sessionQueryBridge: { getSession: mockGetSession } },
}))

vi.mock('@/platform', () => ({
  default: {
    exporter: {
      exportTextFile: mockExportTextFile,
    },
  },
}))

vi.mock('@/lib/format-chat', () => ({
  formatChatAsHtml: mockFormatHtml,
  formatChatAsMarkdown: mockFormatMarkdown,
  formatChatAsTxt: mockFormatTxt,
}))

import { exportSessionChat } from './export'

function createBranchedSession(): Session {
  const pivot = createMessage('user', 'question')
  pivot.id = 'pivot'
  const replies = ['branch-one', 'branch-two', 'branch-active'].map((text) => {
    const reply = createMessage('assistant', text)
    reply.id = text
    return reply
  })
  return {
    id: 'session-1',
    name: 'Branched session',
    threadName: 'Current conversation',
    messages: [pivot, replies[2]],
    messageForksHash: {
      [pivot.id]: {
        position: 2,
        createdAt: 1,
        lists: [
          { id: 'list-one', messages: [replies[0]] },
          { id: 'list-two', messages: [replies[1]] },
          { id: 'list-active', messages: [] },
        ],
      },
    },
  }
}

describe('exportSessionChat', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetSession.mockResolvedValue(createBranchedSession())
  })

  it.each<ExportChatFormat>(['HTML', 'Markdown', 'TXT'])('exports every branch as %s', async (format) => {
    await exportSessionChat('session-1', 'current_thread', format)

    const formatter = format === 'HTML' ? mockFormatHtml : format === 'Markdown' ? mockFormatMarkdown : mockFormatTxt
    const exportedThreads = formatter.mock.calls[0]?.[1] ?? []
    const exportedReplies = exportedThreads.map((thread) => {
      const reply = thread.messages.at(-1)
      return reply?.contentParts.find((part) => part.type === 'text')?.text
    })
    expect(exportedReplies).toEqual(['branch-one', 'branch-two', 'branch-active'])
    expect(mockExportTextFile).toHaveBeenCalledOnce()
  })
})
