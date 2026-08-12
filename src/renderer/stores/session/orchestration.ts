import type { Message } from '@shared/types'
import { currentGenerationService } from '@/adapters/CurrentGenerationService'
import type { AgentModeEntrySource } from '@/analytics/agent-mode'
import { guardSessionAction } from './action-guard'

export {
  applyPersistentToolCallPause,
  cancelRunningToolCallBatch,
  createPausedToolCallExecutionContext,
  finishPausedToolCallContinuation,
  isRetryableToolCallStep,
  shouldPersistStreamingChunk,
} from '@chatbox/core/generation'

/**
 * Compatibility facade for existing Renderer callers.
 *
 * Generation state, streaming projection, checkpoints, terminal handling and
 * paused-tool flows now live in the shared GenerationService. Keep these
 * exports stable until every current UI call site has migrated independently.
 */
export function orchestrateGeneration(
  sessionId: string,
  targetMessage: Message,
  options?: {
    operationType?: 'send_message' | 'regenerate'
    appendToMessage?: boolean
    skipAgentModeSuggestion?: boolean
    agentModeEntrySource?: AgentModeEntrySource
    contextMessages?: Message[]
    externalAbortSignal?: AbortSignal
  }
) {
  return currentGenerationService.orchestrate(sessionId, targetMessage, options)
}

export function stopPausedToolCall(sessionId: string, messageId: string, toolCallId: string) {
  return currentGenerationService.stopPausedToolCall(sessionId, messageId, toolCallId)
}

export function continuePausedToolCall(sessionId: string, messageId: string, toolCallId: string) {
  return currentGenerationService.continuePausedToolCall(sessionId, messageId, toolCallId)
}

export function disableToolCallLimitPauseAndContinue(
  sessionId: string,
  messageId: string,
  toolCallId: string,
  scope: 'session' | 'global'
) {
  return currentGenerationService.disableToolCallLimitPauseAndContinue(sessionId, messageId, toolCallId, scope)
}

export async function retryFromLastToolCallAfterApiError(sessionId: string, messageId: string, toolCallId: string) {
  // Regenerate-class entry: enforce the session action gate before delegating
  // to the shared service so a stale caller cannot race a streaming reply.
  if (!(await guardSessionAction(sessionId, 'regenerate'))) {
    return
  }
  return currentGenerationService.retryFromLastToolCallAfterApiError(sessionId, messageId, toolCallId)
}
