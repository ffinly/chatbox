import { CompactionService, type CompactionServiceResult, isAutoCompactionEnabled } from '@shared/application/context'
import type { Settings } from '@shared/types'
import { v4 as uuidv4 } from 'uuid'
import { getLogger } from '@/lib/utils'
import { getTokenizerType } from '@/packages/token-estimation'
import { settingsService } from '@/settings-runtime'
import { setCompactionUIState } from '@/stores/atoms/compactionAtoms'
import * as chatStore from '@/stores/chatStore'
import queryClient from '@/stores/queryClient'
import { sumCachedTokensFromMessages } from '../token'
import { checkOverflow } from './compaction-detector'
import {
  type ContextTokensCacheValue,
  getContextMessagesForTokenEstimation,
  getContextTokensCacheKey,
  getLatestCompactionBoundaryId,
} from './context-tokens'
import { generateSummaryWithStream } from './summary-generator'

const log = getLogger('compaction')

function getModelContextWindowFromSettings(
  providerId: string | undefined,
  modelId: string | undefined,
  settings: Settings
): number | undefined {
  if (!providerId || !modelId) return undefined
  return settings.providers?.[providerId]?.models?.find((model) => model.modelId === modelId)?.contextWindow
}

const compactionService = new CompactionService({
  sessions: {
    getSession: (sessionId) => chatStore.getSession(sessionId),
    getSessionSettings: (sessionId) => chatStore.getSessionSettings(sessionId),
    updateSessionWithMessages: (sessionId, updater) => chatStore.updateSessionWithMessages(sessionId, updater),
  },
  settings: settingsService,
  policy: {
    async shouldCompact({ sessionId, session, sessionSettings, globalSettings }) {
      const providerId = session.settings?.provider ?? globalSettings.defaultChatModel?.provider
      const modelId = session.settings?.modelId ?? globalSettings.defaultChatModel?.model
      if (!modelId) return false

      const maxContextMessageCount = sessionSettings.maxContextMessageCount ?? Number.MAX_SAFE_INTEGER
      const contextMessages = getContextMessagesForTokenEstimation(session, { settings: sessionSettings })
      const tokenizerType = getTokenizerType(providerId && modelId ? { provider: providerId, modelId } : undefined)
      const cacheKey = getContextTokensCacheKey({
        sessionId,
        maxContextMessageCount,
        latestContextMessageId: contextMessages[contextMessages.length - 1]?.id ?? null,
        latestCompactionBoundaryId: getLatestCompactionBoundaryId(session.compactionPoints),
        tokenizerType,
      })

      let contextTokens = queryClient.getQueryData<ContextTokensCacheValue>(cacheKey)?.contextTokens
      if (contextTokens === undefined) {
        const sandboxMode = contextMessages.some((message) => message.files?.length)
        contextTokens = sumCachedTokensFromMessages(contextMessages, undefined, sandboxMode)
        queryClient.setQueryData(cacheKey, {
          contextTokens,
          messageCount: contextMessages.length,
          timestamp: Date.now(),
        })
      }

      return checkOverflow({
        tokens: contextTokens,
        modelId,
        settings: { compactionThreshold: globalSettings.compactionThreshold },
        contextWindow: getModelContextWindowFromSettings(providerId, modelId, globalSettings),
      }).isOverflow
    },
    getSummaryMessages: (session, sessionSettings) =>
      getContextMessagesForTokenEstimation(session, { settings: sessionSettings }),
  },
  summaries: {
    generate: ({ messages, sessionSettings, language, onStreamUpdate }) =>
      generateSummaryWithStream({ messages, sessionSettings, language, onStreamUpdate }),
  },
  logger: {
    log(level, message, context) {
      log.log(level, message, context)
    },
  },
  createId: uuidv4,
})

export interface CompactionOptions {
  force?: boolean
}

export interface CompactionResult {
  success: boolean
  compacted: boolean
  error?: Error
  summaryMessageId?: string
  /** Another compaction for this session was already streaming. */
  alreadyRunning?: boolean
}

export { isAutoCompactionEnabled }

export function isCompactionInProgress(sessionId: string): boolean {
  return compactionService.isInProgress(sessionId)
}

export function needsCompaction(sessionId: string): Promise<boolean> {
  return compactionService.needsCompaction(sessionId)
}

export async function runCompactionWithUIState(
  sessionId: string,
  options: CompactionOptions = {}
): Promise<CompactionResult> {
  if (compactionService.isInProgress(sessionId)) {
    return { success: true, compacted: false, alreadyRunning: true }
  }
  if (!options.force && !(await compactionService.needsCompaction(sessionId))) {
    return { success: true, compacted: false }
  }

  setCompactionUIState(sessionId, { status: 'running', error: null, streamingText: '' })
  const result = mapResult(
    await compactionService.run(sessionId, {
      force: true,
      onStreamUpdate: (text) => setCompactionUIState(sessionId, { streamingText: text }),
    })
  )

  if (result.alreadyRunning) {
    return result
  }

  if (result.success) {
    setCompactionUIState(sessionId, { status: 'idle', error: null, streamingText: '' })
  } else {
    setCompactionUIState(sessionId, {
      status: 'failed',
      error: result.error?.message ?? 'Compaction failed',
      streamingText: '',
    })
  }
  return result
}

function mapResult(result: CompactionServiceResult): CompactionResult {
  if (!result.failure) return result
  return {
    success: result.success,
    compacted: result.compacted,
    error: result.failure.cause instanceof Error ? result.failure.cause : new Error(result.failure.message),
    summaryMessageId: result.summaryMessageId,
  }
}
