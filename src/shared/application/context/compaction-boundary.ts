import { isContextEligibleMessage } from '../../context/message-eligibility'
import type { Message } from '../../types'

/**
 * Find the last non-summary message that survives context eligibility filters.
 * Keep this predicate aligned with shared context building.
 */
export function findLastCompactionBoundaryMessage(messages: Message[]): Message | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (isContextEligibleMessage(message) && !message.isSummary) {
      return message
    }
  }
  return undefined
}
