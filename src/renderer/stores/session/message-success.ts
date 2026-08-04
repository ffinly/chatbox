import type { Message } from '@shared/types'
import { getMessageText, isEmptyMessage } from '@shared/utils/message'

const UNSUCCESSFUL_FINISH_REASONS = new Set([
  'agent-mode-suggested',
  'canceled',
  'cancelled',
  'content-filter',
  'error',
  'tool-call-paused',
])

function hasMeaningfulAssistantOutput(message: Message): boolean {
  const text = getMessageText(message, true, true).trim()
  if (text.length > 0) return true

  return message.contentParts.some((part) => {
    if (part.type === 'image') return true
    if (part.type !== 'tool-call') return false
    return part.state === 'result' && part.result !== undefined
  })
}

function isFailedOrNonReplyAssistant(message: Message): boolean {
  if (message.role !== 'assistant') return true
  if (message.error || message.errorCode) return true
  // finishReason only describes a settled turn. Resuming a paused tool call flips
  // generating back to true without clearing the stale 'tool-call-paused' reason,
  // so it must not disqualify a message that is generating again.
  if (!message.generating && message.finishReason && UNSUCCESSFUL_FINISH_REASONS.has(message.finishReason)) return true
  if (message.contentParts.some((part) => part.type === 'agent-mode-suggestion')) return true
  if (message.contentParts.some((part) => part.type === 'tool-call' && part.state === 'paused')) return true
  return false
}

export function isSuccessfulAssistantReply(message: Message): boolean {
  if (message.role !== 'assistant') return false
  if (message.generating) return false
  if (isFailedOrNonReplyAssistant(message)) return false
  return hasMeaningfulAssistantOutput(message)
}

/**
 * Whether the session has enough content to auto-generate a title.
 *
 * Unlike {@link hasSuccessfulUserAssistantTurn}, this allows in-progress assistant
 * messages (e.g. long agent-mode tool loops) so titles are not stuck on "Untitled"
 * until the entire multi-round response finishes. The naming prompt can work from
 * the user message alone once an assistant turn has started.
 */
export function hasContentForAutoTitle(messages: Message[]): boolean {
  let hasPreviousUserMessage = false

  for (const message of messages) {
    if (message.role === 'user' && !isEmptyMessage(message)) {
      hasPreviousUserMessage = true
      continue
    }

    if (!hasPreviousUserMessage || message.role !== 'assistant') {
      continue
    }

    if (isFailedOrNonReplyAssistant(message)) {
      continue
    }

    // In-progress turns are enough: agent mode may run tools for a long time
    // before emitting the first visible text token.
    if (message.generating || hasMeaningfulAssistantOutput(message)) {
      return true
    }
  }

  return false
}

export function hasSuccessfulUserAssistantTurn(messages: Message[]): boolean {
  let hasPreviousUserMessage = false

  for (const message of messages) {
    if (message.role === 'user' && !isEmptyMessage(message)) {
      hasPreviousUserMessage = true
      continue
    }

    if (hasPreviousUserMessage && isSuccessfulAssistantReply(message)) {
      return true
    }
  }

  return false
}
