import { buildContext } from '@shared/context'
import { GenerationService, type GenerationServiceDependencies, type GenerationSessionPort } from '@shared/generation'
import type { LoggerPort } from '@shared/ports'
import type { Message, Session, SessionSettings } from '@shared/types'
import type { ModelDependencies } from '@shared/types/adapters'
import {
  captureAgentModeException,
  trackAgentModePauseAction,
  trackAgentModeSuggested,
  trackWorkModeSuggestionDecision,
} from '@/analytics/agent-mode'
import { getLogger } from '@/lib/utils'
import * as appleAppStore from '@/packages/apple_app_store'
import { wakeBackgroundTaskFollowUps } from '@/packages/chatbox-cli/background-follow-up'
import { estimateTokensFromMessages } from '@/packages/token'
import platform from '@/platform'
import { createSandboxProvider } from '@/sandbox'
import { settingsService } from '@/settings-runtime'
import { StorageKeyGenerator } from '@/storage/StoreStorage'
import * as chatStore from '@/stores/chatStore'
import { markFirstSuccessfulChatCompleted } from '@/stores/firstSuccessfulChat'
import { prepareAgentGenerationHarness, refreshSessionAttachmentStatuses } from '@/stores/session/agent-harness'
import { getSessionAgentModeEntry, lockSessionAgentMode, setSessionAgentMode } from '@/stores/session/agent-mode'
import { findMessageLocation } from '@/stores/session/forks'
import { withSessionGenerationLock } from '@/stores/session/generation-lock'
import { generationRuntimeStore } from '@/stores/session/generation-runtime'
import { wakeQueuedUserMessages } from '@/stores/session/message-queue'
import {
  insertMessageAfter,
  modifyMessage,
  persistStreamingMessage,
  updateStreamingCache,
} from '@/stores/session/messages'
import { registerSteeringConsumer } from '@/stores/session/steering'
import { buildToolsForSession } from '@/stores/session/tools-builder'
import {
  findTargetMessageIndex,
  getCompactionPointsForTarget,
  getSessionWebBrowsing,
  handleGenerationError,
  initializeTargetMessage,
  trackGenerateEvent,
} from '@/stores/session/utils'
import * as settingActions from '@/stores/settingActions'
import { uiStore } from '@/stores/uiStore'
import { trackEvent } from '@/utils/track'
import { CurrentAttachmentAdapter } from './CurrentAttachmentAdapter'
import { CurrentBlobStorage } from './CurrentBlobStorage'
import { currentModelFactory } from './CurrentModelFactory'
import { CurrentPlatformCapabilities } from './CurrentPlatformCapabilities'
import { createModelDependencies } from './RendererModelDependencies'

const log = getLogger('generation-service')
const attachmentAdapter = new CurrentAttachmentAdapter()

const logger: LoggerPort = {
  log(level, message, context) {
    log.log(level, message, context)
  },
}

const sessions: GenerationSessionPort = {
  getSession: (sessionId) => chatStore.getSession(sessionId),
  getSessionSettings: (sessionId) => chatStore.getSessionSettings(sessionId),
  updateSessionSettings: async (sessionId, update) => {
    await chatStore.updateSession(sessionId, (current) => {
      if (!current) {
        throw new Error(`Session ${sessionId} not found`)
      }
      return { ...current, settings: update(current.settings) }
    })
  },
  initializeTargetMessage: (message, settings, globalSettings, sessionType) =>
    initializeTargetMessage(message, settings, globalSettings, sessionType),
  persistStreamingMessage: (sessionId, message, options) => persistStreamingMessage(sessionId, message, options),
  updateStreamingCache: (sessionId, message) => updateStreamingCache(sessionId, message),
  findTargetMessageIndex: (session, messageId) => findTargetMessageIndex(session, messageId),
  getCompactionPointsForTarget: (session, messageId) => getCompactionPointsForTarget(session, messageId),
  findMessage(session, messageId) {
    const location = findMessageLocation(session, messageId)
    return location ? location.list[location.index] : undefined
  },
  modifyMessage: (sessionId, message, refreshCounting, updateOnlyCache) =>
    modifyMessage(sessionId, message, refreshCounting, updateOnlyCache),
  handleGenerationError: (error, message, settings, context) =>
    handleGenerationError(error, message, settings, context),
}

async function buildToolsForPausedToolCall(session: Session, settings: SessionSettings, targetMessage: Message) {
  const modelDependencies = await createModelDependencies()
  const model = await currentModelFactory.createModel(settings, modelDependencies)
  const location = findTargetMessageIndex(session, targetMessage.id)
  const messagesBeforeTarget = location ? location.messages.slice(0, location.index) : session.messages
  const agentModeSupported = platform.isDesktopLike && model.isSupportToolUse('agent')
  const { value: storedAgentModeValue } = getSessionAgentModeEntry(session.id, session)
  const agentModeValue = agentModeSupported ? storedAgentModeValue : 'off'
  const effectiveAgentMode = agentModeSupported && agentModeValue === 'on' ? 'on' : 'off'

  const sandboxProvider = effectiveAgentMode !== 'off' ? createSandboxProvider() : null
  const userWorkingDirectories = settings.workingDirectories?.filter((dir) => dir.trim().length > 0) ?? []
  if (sandboxProvider && userWorkingDirectories.length > 0) {
    sandboxProvider.setExtraWritableDirs(userWorkingDirectories)
  }
  let canExecuteCode = Boolean(sandboxProvider && model.isSupportToolUse('agent'))
  if (canExecuteCode && sandboxProvider?.type === 'cloud' && !settingActions.isPro()) {
    canExecuteCode = false
  }
  if (canExecuteCode && sandboxProvider) {
    const availability = await sandboxProvider.checkAvailability()
    if (!availability.available) {
      canExecuteCode = false
    }
  }

  const messagesForPrompt = await refreshSessionAttachmentStatuses(messagesBeforeTarget)
  const promptMessages = await buildContext(messagesForPrompt, {
    attachmentResolver: attachmentAdapter,
    compactionPoints: getCompactionPointsForTarget(session, targetMessage.id),
    modelSupportToolUseForFile: model.isSupportToolUse('read-file'),
    maxContextMessageCount: settings.maxContextMessageCount,
    sandboxMode: canExecuteCode,
  })

  const knowledgeBase = uiStore.getState().sessionKnowledgeBaseMap[session.id]
  const webBrowsing = getSessionWebBrowsing(session.id, settings.provider)
  const codeExecution =
    canExecuteCode && sandboxProvider
      ? {
          sessionId: session.id,
          provider: sandboxProvider,
          files: messagesBeforeTarget.flatMap(
            (message) =>
              message.files?.map((file) => ({
                storageKey: file.storageKey || '',
                rawStorageKey: file.rawStorageKey,
                name: file.name,
              })) || []
          ),
        }
      : undefined

  const { tools } = await buildToolsForSession(model, {
    sessionId: session.id,
    webBrowsing,
    knowledgeBase,
    messages: promptMessages,
    agentMode: effectiveAgentMode,
    sessionSettings: settings,
    codeExecution,
    onAgentModeActivated: () => {
      void lockSessionAgentMode(session.id, 'load_skill')
    },
  })
  return tools
}

const dependencies: GenerationServiceDependencies<ModelDependencies> = {
  sessions,
  settings: settingsService,
  models: {
    createModel(settings) {
      return currentModelFactory.createModel(settings)
    },
    async createContext(settings) {
      const context = await createModelDependencies()
      return {
        model: await currentModelFactory.createModel(settings, context),
        context,
      }
    },
    createWithContext(settings, context) {
      return currentModelFactory.createModel(settings, context)
    },
  },
  preparation: {
    async prepare(request) {
      const prepared = await prepareAgentGenerationHarness({
        session: request.session,
        settings: request.settings,
        globalSettings: request.globalSettings,
        configs: request.config,
        messages: request.messages,
        targetMsgIx: request.targetMessageIndex,
        model: request.model,
        dependencies: request.modelContext,
        attachmentResolver: request.attachments,
        knowledgeBase: request.knowledgeBase,
        webBrowsing: request.webBrowsing,
        agentModeValue: request.agentModeValue,
        agentModeLocked: request.agentModeLocked,
        agentModeSupported: request.agentModeSupported,
        signal: request.signal,
        providerOptions: request.providerOptions,
        preserveLastPromptMessageToolCalls: request.preserveLastPromptMessageToolCalls,
        compactionPoints: request.compactionPoints,
        sideEffects: {
          lockAgentMode: request.lockAgentMode,
        },
        isPro: settingActions.isPro,
      })
      return {
        promptMessages: prepared.promptMsgs,
        coreMessages: prepared.coreMessages,
        tools: prepared.tools,
        chatOptions: prepared.chatOptions,
        infoParts: prepared.infoParts,
        fallbackToolCallPart: prepared.fallbackToolCallPart,
      }
    },
  },
  tools: {
    buildToolsForPausedToolCall,
  },
  coordination: {
    runExclusive: (sessionId, operation) => withSessionGenerationLock(sessionId, operation),
    wakeBackgroundTaskFollowUps: (sessionId) => wakeBackgroundTaskFollowUps(sessionId),
  },
  steering: {
    register: (sessionId, anchorMessageId, conversationMessageIds) =>
      registerSteeringConsumer(sessionId, anchorMessageId, conversationMessageIds, (message, afterMessageId) =>
        insertMessageAfter(sessionId, message, afterMessageId)
      ),
    wake: (sessionId) => wakeQueuedUserMessages(sessionId),
  },
  runtime: generationRuntimeStore,
  blobs: new CurrentBlobStorage(),
  attachments: attachmentAdapter,
  capabilities: new CurrentPlatformCapabilities(),
  host: {
    getConfig: () => platform.getConfig(),
    getKnowledgeBase: (sessionId) => uiStore.getState().sessionKnowledgeBaseMap[sessionId],
    getWebBrowsing: (sessionId, provider) => getSessionWebBrowsing(sessionId, provider),
    getAgentModeEntry: (sessionId, session) => getSessionAgentModeEntry(sessionId, session),
    async setAgentMode(sessionId, value) {
      await setSessionAgentMode(sessionId, value)
    },
    async lockAgentMode(sessionId, reason) {
      await lockSessionAgentMode(sessionId, reason)
    },
    createPictureStorageKey: (sessionId, messageId) => StorageKeyGenerator.picture(`${sessionId}:${messageId}`),
    estimateTokens: (messages) => estimateTokensFromMessages(messages),
    markFirstSuccessfulChatCompleted: () => markFirstSuccessfulChatCompleted(),
    afterMessageGenerated: () => appleAppStore.tickAfterMessageGenerated(),
    now: Date.now,
  },
  analytics: {
    init: () => undefined,
    event: (name, params) => trackEvent(name, params),
    trackGenerate: (sessionId, settings, globalSettings, sessionType, options) =>
      trackGenerateEvent(sessionId, settings, globalSettings, sessionType, options),
    trackSuggestionDecision(context, suggested, fileCount) {
      trackWorkModeSuggestionDecision({ ...context, mode: 'chat_mode' }, suggested, fileCount)
    },
    trackAgentModeSuggested: (context) => trackAgentModeSuggested(context),
    trackPauseAction: (options) => trackAgentModePauseAction(options),
    captureException: (error, context) => captureAgentModeException(error, context),
  },
  logger,
}

/**
 * Current Renderer composition root for the host-neutral generation service.
 * React Native can compose the same service with native implementations of
 * these ports without importing Renderer state, storage, or platform modules.
 */
export const currentGenerationService = new GenerationService(dependencies)
