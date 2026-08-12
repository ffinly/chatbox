import type { ExportChatFormat, ExportChatScope } from '@shared/types'
import { buildSessionExportThreads } from '@shared/utils/chat-export'
import { formatChatAsHtml, formatChatAsMarkdown, formatChatAsTxt } from '@/lib/format-chat'
import platform from '@/platform'
import * as chatStore from '../chatStore'

export async function exportSessionChat(sessionId: string, content: ExportChatScope, format: ExportChatFormat) {
  const session = await chatStore.getSession(sessionId)
  if (!session) {
    return
  }
  const threads = buildSessionExportThreads(session, content === 'all_threads')

  if (format === 'Markdown') {
    const exportedContent = formatChatAsMarkdown(session.name, threads)
    await platform.exporter.exportTextFile(`${session.name}.md`, exportedContent)
  } else if (format === 'TXT') {
    const exportedContent = formatChatAsTxt(session.name, threads)
    await platform.exporter.exportTextFile(`${session.name}.txt`, exportedContent)
  } else if (format === 'HTML') {
    const exportedContent = await formatChatAsHtml(session.name, threads)
    await platform.exporter.exportTextFile(`${session.name}.html`, exportedContent)
  }
}
