import { withSessionGenerationLock } from '@chatbox/core/generation'
import { buildContext, selectContextMessages } from '@shared/context'
import type { AttachmentResolver } from '@shared/context/types'
import { supportsSessionGeneration } from '@shared/session/capabilities'
import { findMessageContext } from '@shared/session/message-forks'
import { type CompactionPoint, createMessage, type Message, type Session, type SessionSettings } from '@shared/types'
import { currentGenerationService } from '@/adapters/CurrentGenerationService'
import { rendererApplication } from '@/app/renderer-application'
import { assessContextPressure, getConfiguredContextWindow } from '@/packages/context-management/context-pressure'
import { settingsStore } from '@/stores/settingsStore'
import { guardSessionAction } from './action-guard'
import { createAttachmentResolver } from './attachment-resolver'
import { createInactiveFork, createNewFork, findMessageLocation } from './forks'
import { insertMessageAfter } from './messages'
import { getSessionSettings } from './session-settings'
import type { AgentModeEntrySource } from './types'

/** Internal generation entry point for callers that already hold the session generation lock. */
export async function _generateWithoutSessionLock(
  sessionId: string,
  targetMsg: Message,
  options?: {
    operationType?: 'send_message' | 'regenerate'
    skipAgentModeSuggestion?: boolean
    agentModeEntrySource?: AgentModeEntrySource
    contextMessages?: Message[]
  }
) {
  const session = await rendererApplication.sessionQueryBridge.getSession(sessionId)
  const settings = await getSessionSettings(sessionId)
  if (!session || !settings) {
    return
  }

  if (!supportsSessionGeneration(session.type)) {
    return
  }

  await currentGenerationService.orchestrate(sessionId, targetMsg, options)
}

export async function retryFromLastToolCallAfterApiError(sessionId: string, messageId: string, toolCallId: string) {
  // Regenerate-class entry: enforce the session action gate before delegating
  // to the shared service so a stale caller cannot race a streaming reply.
  if (!(await guardSessionAction(sessionId, 'regenerate'))) {
    return
  }
  return currentGenerationService.retryFromLastToolCallAfterApiError(sessionId, messageId, toolCallId)
}

export function generate(
  sessionId: string,
  targetMsg: Message,
  options?: {
    operationType?: 'send_message' | 'regenerate'
    skipAgentModeSuggestion?: boolean
    agentModeEntrySource?: AgentModeEntrySource
  }
) {
  return withSessionGenerationLock(sessionId, () => _generateWithoutSessionLock(sessionId, targetMsg, options))
}

/**
 * Insert and generate a new message below the target message
 * @param sessionId Session ID
 * @param msgId Message ID
 */
async function generateActiveReplyWithoutSessionLock(sessionId: string, msgId: string) {
  const newAssistantMsg = createMessage('assistant', '')
  newAssistantMsg.generating = true // prevent estimating token count before generating done
  await insertMessageAfter(sessionId, newAssistantMsg, msgId)
  await _generateWithoutSessionLock(sessionId, newAssistantMsg, { operationType: 'regenerate' })
}

async function generateInactiveReply(sessionId: string, msgId: string) {
  const newAssistantMsg = createMessage('assistant', '')
  newAssistantMsg.generating = true
  const contextMessages = await createInactiveFork(sessionId, msgId, [newAssistantMsg])

  if (!contextMessages) {
    await insertMessageAfter(sessionId, newAssistantMsg, msgId)
    await _generateWithoutSessionLock(sessionId, newAssistantMsg, { operationType: 'regenerate' })
    return
  }

  await _generateWithoutSessionLock(sessionId, newAssistantMsg, {
    operationType: 'regenerate',
    contextMessages,
  })
}

export async function generateMore(sessionId: string, msgId: string) {
  const session = await rendererApplication.sessionQueryBridge.getSession(sessionId)
  if (!session || !supportsSessionGeneration(session.type)) {
    return
  }
  return generateInactiveReply(sessionId, msgId)
}

export function generateMoreInNewFork(sessionId: string, msgId: string) {
  // Save & Resend resolves the target again inside the session lock. The
  // target may have started streaming since the editor's pre-check, including
  // the short window before its AbortController is registered.
  return withSessionGenerationLock(sessionId, async () => {
    let session: Session | null
    try {
      session = await rendererApplication.sessionQueryBridge.getSession(sessionId)
    } catch {
      // MessageEdit intentionally void-calls this action. Keep storage/query
      // read failures from escaping as unhandled rejections.
      return
    }
    if (!session || !supportsSessionGeneration(session.type)) {
      return
    }
    const location = findMessageLocation(session, msgId)
    if (!location) {
      return
    }
    const targetMessage = location.list[location.index]
    if (
      !(await guardSessionAction(
        sessionId,
        'save-and-resend',
        { messageGenerating: targetMessage.generating === true },
        session
      ))
    ) {
      return
    }
    await createNewFork(sessionId, msgId)
    await generateActiveReplyWithoutSessionLock(sessionId, msgId)
  })
}

type GenerateMoreFn = (sessionId: string, msgId: string) => Promise<void>

export function regenerateInNewFork(sessionId: string, msg: Message, options?: { runGenerateMore?: GenerateMoreFn }) {
  return withSessionGenerationLock(sessionId, async () => {
    if (!(await guardSessionAction(sessionId, 'regenerate'))) {
      return
    }
    return regenerateInNewForkWithoutSessionLock(sessionId, msg, options)
  })
}

async function regenerateInNewForkWithoutSessionLock(
  sessionId: string,
  msg: Message,
  options?: { runGenerateMore?: GenerateMoreFn }
) {
  const runGenerateMore = options?.runGenerateMore ?? generateActiveReplyWithoutSessionLock
  const session = await rendererApplication.sessionQueryBridge.getSession(sessionId)
  if (!session || !supportsSessionGeneration(session.type)) {
    return
  }
  const location = findMessageLocation(session, msg.id)
  if (!location) {
    await _generateWithoutSessionLock(sessionId, msg, { operationType: 'regenerate' })
    return
  }
  // Skip anchored compaction summaries: a summary sits immediately after its
  // boundary and belongs to the shared prefix, so the fork pivot must be the
  // real conversation message before it (forks keyed on a summary id would
  // attach navigation to SummaryMessage and break when it is deleted).
  let previousMessageIndex = location.index - 1
  while (previousMessageIndex >= 0 && location.list[previousMessageIndex].isSummary) {
    previousMessageIndex -= 1
  }
  if (previousMessageIndex < 0) {
    // If target message is the first message, regenerate directly
    await _generateWithoutSessionLock(sessionId, msg, { operationType: 'regenerate' })
    return
  }
  const forkMessage = location.list[previousMessageIndex]
  await createNewFork(sessionId, forkMessage.id)
  return runGenerateMore(sessionId, forkMessage.id)
}

/**
 * Build message context for prompt
 * Thin wrapper over shared buildContext() for backward compatibility
 *
 * @param settings Session settings
 * @param msgs Original message list
 * @param modelSupportToolUseForFile Whether model supports file reading tool (if supported, file content is not directly included)
 * @param optionsOrAdapter Optional configuration object OR legacy storageAdapter (for backward compatibility)
 * @returns Processed message list
 */
export async function genMessageContext(
  settings: SessionSettings,
  msgs: Message[],
  modelSupportToolUseForFile: boolean,
  optionsOrAdapter?:
    | {
        storageAdapter?: { getBlob: (key: string) => Promise<string> }
        compactionPoints?: CompactionPoint[]
      }
    | { getBlob: (key: string) => Promise<string> }
): Promise<Message[]> {
  let storageAdapter: { getBlob: (key: string) => Promise<string> } | undefined
  let compactionPoints: CompactionPoint[] | undefined

  if (optionsOrAdapter) {
    if ('getBlob' in optionsOrAdapter) {
      storageAdapter = optionsOrAdapter
    } else {
      storageAdapter = optionsOrAdapter.storageAdapter
      compactionPoints = optionsOrAdapter.compactionPoints
    }
  }

  const attachmentResolver = storageAdapter
    ? createAttachmentResolverFromAdapter(storageAdapter)
    : createAttachmentResolver()

  // Same pressure gating as the agent harness: keep tool history intact until
  // the context approaches the compaction threshold, then stub old results.
  const globalSettings = settingsStore.getState().getSettings()
  const contextPressure = assessContextPressure({
    contextMessages: selectContextMessages(msgs, {
      compactionPoints,
      maxContextMessageCount: settings.maxContextMessageCount,
    }),
    providerId: settings.provider,
    modelId: settings.modelId,
    contextWindow: getConfiguredContextWindow(globalSettings, settings.provider, settings.modelId),
    compactionThreshold: globalSettings.compactionThreshold,
  })

  return buildContext(msgs, {
    attachmentResolver,
    compactionPoints,
    maxContextMessageCount: settings.maxContextMessageCount,
    toolCleanupMode: contextPressure.toolCleanupMode,
    modelSupportToolUseForFile,
  })
}

/**
 * Helper to create AttachmentResolver from legacy storageAdapter interface
 * Used by integration tests that pass custom storage adapter
 */
function createAttachmentResolverFromAdapter(adapter: {
  getBlob: (key: string) => Promise<string>
}): AttachmentResolver {
  return {
    async read(id) {
      return adapter.getBlob(id).catch(() => null as string | null)
    },
  }
}

/**
 * Find the thread message list that a message belongs to
 * @param sessionId Session ID
 * @param messageId Message ID
 * @returns The thread message list containing the message
 */
export async function getMessageThreadContext(sessionId: string, messageId: string): Promise<Message[]> {
  const session = await rendererApplication.sessionQueryBridge.getSession(sessionId)
  if (!session) {
    return []
  }
  return findMessageContext(session, messageId)?.list ?? []
}

// Re-export for backward compatibility
export { getSessionWebBrowsing } from './utils'
