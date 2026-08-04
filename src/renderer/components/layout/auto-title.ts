import type { Session } from '@shared/types'
import { hasContentForAutoTitle } from '@/stores/session'

export type AutoTitleGenerationAction = 'session-and-thread' | 'thread'

export function getAutoTitleGenerationAction(
  session: Pick<Session, 'messages' | 'name' | 'threadName'>
): AutoTitleGenerationAction | null {
  // Do not wait for generating to finish — agent-mode replies can span many tool
  // rounds. Naming can start once a user turn has an assistant reply in progress.
  if (!hasContentForAutoTitle(session.messages)) return null
  if (session.name === 'Untitled') return 'session-and-thread'
  if (!session.threadName) return 'thread'
  return null
}
