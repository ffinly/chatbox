import { buildAgentPersonaPrompt, buildMemoriesSection } from '@shared/agent-persona/prompt'
import { buildContext } from '@shared/context'
import type { AttachmentResolver } from '@shared/context/types'
import { ChatboxAIAPIError, OCRError } from '@shared/models/errors'
import type { ChatStreamOptions, ModelInterface } from '@shared/models/types'
import type { SandboxProvider } from '@shared/sandbox-provider'
import { supportsToolResultImages } from '@shared/tools/view-image'
import type {
  AgentModeLockReason,
  AgentModeValue,
  AgentPromptSnapshot,
  CompactionPoint,
  Config,
  KnowledgeBase,
  Message,
  MessageContentParts,
  Session,
  SessionSettings,
  Settings,
} from '@shared/types'
import type { ModelDependencies } from '@shared/types/adapters'
import { sequenceMessages } from '@shared/utils/message'
import { shouldPreserveDeepSeekReasoning } from '@shared/utils/reasoning-control'
import type { ToolSet } from 'ai'
import dayjs from 'dayjs'
import { t } from 'i18next'
import { getLogger } from '@/lib/utils'
import {
  hasAcceptedCallbackBackgroundTask,
  hasAcceptedCallbackBackgroundTaskResult,
} from '@/packages/chatbox-cli/background-task-result'
import {
  buildModelSystemPrompt,
  convertToModelMessages,
  injectModelSystemPrompt,
} from '@/packages/model-calls/message-utils'
import { getOS } from '@/packages/navigator'
import platform from '@/platform'
import { createSandboxProvider } from '@/sandbox'

import { SESSION_ATTACHMENT_RAG_LOG_PREFIX } from '../../../shared/session-attachment-rag/logging'
import { createAttachmentResolver } from './attachment-resolver'
import { applyLegacyToolFallback } from './legacy-tool-fallback'
import { getOCRModel, ocrImagesInMessages } from './ocr-helper'
import { resolvePersonaSnapshot } from './persona-snapshot'
import { buildToolsForSession } from './tools-builder'

const log = getLogger('agent-generation-harness')
const RECENT_TOOL_CALL_CACHE_WINDOW_MS = 5 * 60 * 1000

const GLOBAL_RESPONSE_LANGUAGE_INSTRUCTION = `
## Response Language
Unless the user requests otherwise, all visible assistant text must be in the same language as the user's latest message.
`

export interface AgentGenerationSideEffects {
  lockAgentMode?: (reason: Exclude<AgentModeLockReason, null>) => void
  /** Persist a freshly captured persona snapshot into the session settings. */
  persistAgentPromptSnapshot?: (snapshot: AgentPromptSnapshot) => void
}

export interface PrepareAgentGenerationHarnessOptions {
  session: Session
  settings: SessionSettings
  globalSettings: Settings
  configs: Config
  messages: Message[]
  targetMsgIx: number
  model: ModelInterface
  dependencies: ModelDependencies
  knowledgeBase?: Pick<KnowledgeBase, 'id' | 'name'>
  webBrowsing: boolean
  agentModeValue: AgentModeValue
  agentModeLocked: boolean
  agentModeSupported: boolean
  signal: AbortSignal
  providerOptions?: SessionSettings['providerOptions']
  /**
   * Points of the conversation being generated (thread-level when the target
   * message lives in an archived thread). Defaults to session.compactionPoints.
   */
  compactionPoints?: CompactionPoint[]
  preserveLastPromptMessageToolCalls?: boolean
  attachmentResolver?: AttachmentResolver
  sideEffects?: AgentGenerationSideEffects
  sandboxProviderFactory?: () => SandboxProvider | null
  isPro?: () => boolean
}

export interface PreparedAgentGenerationHarness {
  promptMsgs: Message[]
  coreMessages: Awaited<ReturnType<typeof convertToModelMessages>>
  tools: ToolSet
  chatOptions: ChatStreamOptions
  infoParts: MessageContentParts
  fallbackToolCallPart: MessageContentParts[number] | undefined
  systemPrompt: string | undefined
  sandboxProvider: SandboxProvider | null
  debug: {
    effectiveAgentMode: 'on' | 'off'
    canExecuteCode: boolean
    toolNames: string[]
    instructions: string
  }
}

export function computeEffectiveAgentMode(agentModeValue: AgentModeValue, agentModeSupported: boolean): 'on' | 'off' {
  if (!agentModeSupported || agentModeValue === 'off') return 'off'
  return agentModeValue === 'on' ? 'on' : 'off'
}

function getToolCallPreserveMessageIds(
  messages: Message[],
  targetMsgIx: number,
  preserveLastPromptMessageToolCalls: boolean
): string[] {
  const ids = new Set<string>()
  const targetMessage = messages[targetMsgIx]
  const previousMessage = messages[targetMsgIx - 1]

  if (preserveLastPromptMessageToolCalls && previousMessage) {
    ids.add(previousMessage.id)
  }

  if (targetMessage?.timestamp !== undefined && previousMessage?.timestamp !== undefined) {
    const interval = targetMessage.timestamp - previousMessage.timestamp
    if (interval >= 0 && interval <= RECENT_TOOL_CALL_CACHE_WINDOW_MS) {
      ids.add(previousMessage.id)
    }
  }

  return [...ids]
}

export async function refreshSessionAttachmentStatuses(messages: Message[]): Promise<Message[]> {
  if (platform.type !== 'desktop') {
    return messages
  }

  const ids = Array.from(
    new Set(
      messages.flatMap((message) =>
        (message.files ?? [])
          .filter((file) => file.sessionAttachmentId)
          .map((file) => file.sessionAttachmentId as number)
      )
    )
  )

  if (ids.length === 0) {
    return messages
  }

  const controller = platform.getSessionAttachmentRagController()
  const attachments = await controller.getAttachments(ids)
  log.debug(
    `${SESSION_ATTACHMENT_RAG_LOG_PREFIX} Refreshed attachment statuses: count=${attachments.length}, statuses=${attachments
      .map((attachment) => `${attachment.id}:${attachment.indexStatus ?? attachment.status}`)
      .join(',')}`
  )
  const availabilityMap = new Map(attachments.map((attachment) => [attachment.id, attachment.availability]))
  const indexStatusMap = new Map(attachments.map((attachment) => [attachment.id, attachment.indexStatus]))
  const chunkCountMap = new Map(attachments.map((attachment) => [attachment.id, attachment.chunkCount]))
  const totalChunksMap = new Map(attachments.map((attachment) => [attachment.id, attachment.totalChunks]))
  const embeddedChunksMap = new Map(attachments.map((attachment) => [attachment.id, attachment.embeddedChunks]))
  const indexingStageMap = new Map(attachments.map((attachment) => [attachment.id, attachment.indexingStage]))

  return messages.map((message) => {
    if (!message.files?.length) {
      return message
    }

    const files = message.files.map((file) => {
      if (!file.sessionAttachmentId) {
        return file
      }
      return {
        ...file,
        sessionAttachmentAvailability:
          availabilityMap.get(file.sessionAttachmentId) ?? file.sessionAttachmentAvailability,
        sessionAttachmentIndexStatus: indexStatusMap.get(file.sessionAttachmentId) ?? file.sessionAttachmentIndexStatus,
        sessionAttachmentStatus: indexStatusMap.get(file.sessionAttachmentId) ?? file.sessionAttachmentStatus,
        sessionAttachmentChunkCount: chunkCountMap.get(file.sessionAttachmentId) ?? file.sessionAttachmentChunkCount,
        sessionAttachmentTotalChunks: totalChunksMap.get(file.sessionAttachmentId) ?? file.sessionAttachmentTotalChunks,
        sessionAttachmentEmbeddedChunks:
          embeddedChunksMap.get(file.sessionAttachmentId) ?? file.sessionAttachmentEmbeddedChunks,
        sessionAttachmentIndexingStage:
          indexingStageMap.get(file.sessionAttachmentId) ?? file.sessionAttachmentIndexingStage,
      }
    })

    return { ...message, files }
  })
}

export async function prepareAgentGenerationHarness(
  options: PrepareAgentGenerationHarnessOptions
): Promise<PreparedAgentGenerationHarness> {
  const {
    session,
    settings,
    globalSettings,
    configs,
    messages,
    targetMsgIx,
    model,
    dependencies,
    knowledgeBase,
    webBrowsing,
    agentModeValue,
    agentModeLocked,
    agentModeSupported,
    signal,
    providerOptions,
    compactionPoints = session.compactionPoints,
    preserveLastPromptMessageToolCalls = false,
    attachmentResolver = createAttachmentResolver(),
    sideEffects,
    sandboxProviderFactory = createSandboxProvider,
    isPro = () => true,
  } = options

  const allMessages = messages.slice(0, targetMsgIx)
  const resumedMessage = preserveLastPromptMessageToolCalls ? messages[targetMsgIx - 1] : undefined
  const resumedMessageWaitsForCallback =
    Boolean(resumedMessage) && hasAcceptedCallbackBackgroundTaskResult(resumedMessage?.contentParts ?? [])

  if (agentModeSupported && agentModeValue === 'on' && !agentModeLocked) {
    sideEffects?.lockAgentMode?.('message_sent')
  }

  const effectiveAgentMode = computeEffectiveAgentMode(agentModeValue, agentModeSupported)

  // Global memory switch: when off, stored memories are neither injected nor
  // maintained in either mode (Soul/identity are unaffected).
  const memoryEnabled = globalSettings.memoryEnabled !== false
  const personaSnapshot = await resolvePersonaSnapshot({
    effectiveAgentMode,
    memoryEnabled,
    settings,
    messages,
    targetMsgIx,
    persist: sideEffects?.persistAgentPromptSnapshot,
  })

  const sandboxProvider = effectiveAgentMode !== 'off' ? sandboxProviderFactory() : null
  // Grant the sandbox read/write access to any user-bound working directories before it
  // initializes lazily on the first tool call (desktop only; cloud provider no-ops).
  const userWorkingDirectories = settings.workingDirectories?.filter((dir) => dir.trim().length > 0) ?? []
  if (sandboxProvider && userWorkingDirectories.length > 0) {
    sandboxProvider.setExtraWritableDirs(userWorkingDirectories)
  }
  let canExecuteCode = Boolean(sandboxProvider && model.isSupportToolUse('agent'))

  if (canExecuteCode && sandboxProvider?.type === 'cloud' && !isPro()) {
    canExecuteCode = false
  }

  if (canExecuteCode && sandboxProvider) {
    const availability = await sandboxProvider.checkAvailability()
    if (!availability.available) {
      canExecuteCode = false
    }
  }

  const messagesForPrompt = (await refreshSessionAttachmentStatuses(messages.slice(0, targetMsgIx))).map((message) =>
    // A resumed continuation keeps its target message flagged `generating` for the UI,
    // but its tool calls/results are exactly the context the follow-up request must
    // continue from — without this the eligibility filter drops the whole message and
    // the model restarts the task from scratch.
    message.id === resumedMessage?.id && message.generating ? { ...message, generating: false } : message
  )
  const preserveToolCallMessageIds = getToolCallPreserveMessageIds(
    messages,
    targetMsgIx,
    preserveLastPromptMessageToolCalls
  )
  let promptMsgs = await buildContext(messagesForPrompt, {
    attachmentResolver,
    compactionPoints,
    modelSupportToolUseForFile: model.isSupportToolUse('read-file'),
    maxContextMessageCount: settings.maxContextMessageCount,
    preserveToolCallMessageIds,
    sandboxMode: canExecuteCode,
  })

  // Agent mode owns its identity: session-level system prompts (legacy custom
  // prompts, copilot personas) are dropped — the user expresses persona through
  // the global Soul instead.
  if (effectiveAgentMode === 'on') {
    promptMsgs = promptMsgs.filter((message) => message.role !== 'system')
  }

  const infoParts: MessageContentParts = []

  if (
    !model.isSupportVision() &&
    promptMsgs.some((message) => message.contentParts.some((part) => part.type === 'image' && !part.ocrResult))
  ) {
    const ocrResult = getOCRModel(globalSettings, configs, dependencies)
    if (!ocrResult) {
      throw ChatboxAIAPIError.fromCodeName('model_not_support_image_2', 'model_not_support_image_2')
    }
    try {
      await ocrImagesInMessages(promptMsgs, ocrResult.model)
    } catch (err) {
      throw new OCRError(ocrResult.providerName, err instanceof Error ? err : new Error(`${err}`))
    }
    infoParts.push({
      type: 'info',
      text: t('Current model {{modelName}} does not support image input, using OCR to process images', {
        modelName: model.modelId,
      }),
    })
  }

  const { promptMsgs: updatedMsgs, fallbackToolCallPart } = await applyLegacyToolFallback({
    model,
    promptMsgs,
    knowledgeBase,
    webBrowsing,
    signal,
  })
  promptMsgs = updatedMsgs

  const codeExecutionOption =
    canExecuteCode && sandboxProvider
      ? {
          sessionId: session.id,
          provider: sandboxProvider,
          files: allMessages.flatMap(
            (message) =>
              message.files?.map((file) => ({
                storageKey: file.storageKey || '',
                rawStorageKey: file.rawStorageKey,
                name: file.name,
              })) || []
          ),
        }
      : undefined

  const {
    tools,
    instructions: toolInstructions,
    prepareStepMessages,
  } = await buildToolsForSession(model, {
    sessionId: session.id,
    webBrowsing,
    knowledgeBase,
    messages: promptMsgs,
    agentMode: effectiveAgentMode,
    sessionSettings: settings,
    codeExecution: codeExecutionOption,
    onAgentModeActivated: () => {
      sideEffects?.lockAgentMode?.('load_skill')
    },
    workspaceInstructionsOverride: personaSnapshot?.workspaceInstructions,
    globalSettings,
  })
  const hasTools = Object.keys(tools).length > 0
  let instructions = hasTools ? `${GLOBAL_RESPONSE_LANGUAGE_INSTRUCTION}${toolInstructions}` : toolInstructions

  // Chat mode gets memories (no Soul/identity) from the same frozen snapshot,
  // appended to the regular instruction path so the session system prompt stays
  // authoritative. Tool guidance follows whether the memory tools were actually
  // registered for this model.
  if (effectiveAgentMode !== 'on' && memoryEnabled && personaSnapshot && personaSnapshot.memories.length > 0) {
    const memoryToolsAvailable = 'save_memory' in tools
    instructions = `${buildMemoriesSection(personaSnapshot.memories, { includeToolGuidance: memoryToolsAvailable })}${instructions}`
  }

  let injectedMessages: Message[]
  let systemPrompt: string
  if (effectiveAgentMode === 'on' && personaSnapshot) {
    // Agent mode assembles its own system prompt, ordered by stability for prefix
    // caching: fixed identity → frozen Soul/memories → tool instructions → runtime
    // metadata. The date is the snapshot's capture date (not today) so the system
    // prompt never drifts mid-session.
    const personaPrompt = buildAgentPersonaPrompt({
      soul: personaSnapshot.soul,
      memories: memoryEnabled ? personaSnapshot.memories : [],
      platformType: platform.type,
      os: getOS(),
    })
    const runtimeMetadata = `\n## Runtime\nCurrent model: ${model.modelId}\nSession context captured: ${dayjs(personaSnapshot.capturedAt).format('YYYY-MM-DD')}`
    const systemText = `${personaPrompt}\n${instructions}${runtimeMetadata}`
    systemPrompt = systemText
    injectedMessages = [
      {
        id: `agent-system-prompt-${personaSnapshot.capturedAt}`,
        role: model.isSupportSystemMessage() ? 'system' : 'user',
        timestamp: personaSnapshot.capturedAt,
        contentParts: [{ type: 'text', text: systemText }],
      },
      ...promptMsgs,
    ]
  } else {
    systemPrompt = buildModelSystemPrompt(model.modelId, instructions)
    injectedMessages = injectModelSystemPrompt(
      model.modelId,
      promptMsgs,
      instructions,
      model.isSupportSystemMessage() ? 'system' : 'user',
      systemPrompt
    )
  }

  if (!model.isSupportSystemMessage()) {
    injectedMessages = injectedMessages.map((message) => ({
      ...message,
      role: message.role === 'system' ? 'user' : message.role,
    }))
  }

  injectedMessages = sequenceMessages(injectedMessages)

  const coreMessages = await convertToModelMessages(injectedMessages, {
    modelSupportVision: model.isSupportVision(),
    preserveReasoning: shouldPreserveDeepSeekReasoning(settings.provider, {
      modelId: model.modelId,
      apiStyle: model.apiStyle,
    }),
    // getModel() stamps apiStyle from the provider type (builtin/custom Gemini providers)
    // or the per-model remote config (ChatboxAI google-routed models), so it is the single
    // signal for "this request speaks the Gemini function-call protocol".
    ensureGoogleFunctionCallSignatures: model.apiStyle === 'google',
    // Re-inline stored view_image results as images on history resends for protocols
    // that accept media in tool results.
    supportToolResultImages: supportsToolResultImages(model.apiStyle),
  })

  const chatOptions: ChatStreamOptions = {
    sessionId: session.id,
    agentMode: effectiveAgentMode === 'on',
    signal,
    providerOptions,
  }

  if (Object.keys(tools).length > 0) {
    chatOptions.tools = tools as ToolSet
  }

  const allToolNames = Object.keys(tools)
  if (allToolNames.includes('chatbox_cli')) {
    chatOptions.prepareStep = ({ steps }) => {
      return {
        activeTools:
          resumedMessageWaitsForCallback || hasAcceptedCallbackBackgroundTask(steps)
            ? allToolNames.filter((toolName) => toolName !== 'chatbox_cli')
            : allToolNames,
      }
    }
  }

  // Protocols without tool-result media support get view_image results injected as
  // follow-up user messages with real image parts. Compose with any existing prepareStep.
  if (prepareStepMessages) {
    const basePrepareStep = chatOptions.prepareStep
    chatOptions.prepareStep = async (prepareOptions) => {
      const base = await basePrepareStep?.(prepareOptions)
      const stepMessages = await prepareStepMessages(prepareOptions.messages)
      return stepMessages === prepareOptions.messages ? base : { ...base, messages: stepMessages }
    }
  }

  return {
    promptMsgs,
    coreMessages,
    tools,
    chatOptions,
    infoParts,
    fallbackToolCallPart,
    systemPrompt,
    sandboxProvider,
    debug: {
      effectiveAgentMode,
      canExecuteCode,
      toolNames: Object.keys(tools),
      instructions,
    },
  }
}
