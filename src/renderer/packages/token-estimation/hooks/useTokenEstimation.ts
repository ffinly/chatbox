import type { Message } from '@shared/types/session'
import { useEffect, useMemo, useRef, useState } from 'react'
import { analyzeContextTokens, analyzeCurrentInputTokens } from '../analyzer'
import { computationQueue, generateTaskId } from '../computation-queue'
import { getTokenizerType } from '../tokenizer'
import type { TokenEstimationResult } from '../types'

/**
 * During a backfill the queue completes a task every few milliseconds and
 * notifies on every completion; updating React state at that rate re-renders
 * the (large) InputBox per task. Trailing-edge throttle keeps progress visible
 * while bounding the re-render rate.
 */
const QUEUE_STATUS_THROTTLE_MS = 100

export interface UseTokenEstimationOptions {
  sessionId: string | null
  constructedMessage: Message | undefined
  contextMessages: Message[]
  model?: { provider: string; modelId: string }
  modelSupportToolUseForFile: boolean
  sandboxMode?: boolean
}

export function useTokenEstimation(options: UseTokenEstimationOptions): TokenEstimationResult {
  const { sessionId, constructedMessage, contextMessages, model, modelSupportToolUseForFile, sandboxMode } = options

  const tokenizerType = useMemo(() => getTokenizerType(model), [model])

  const [queueStatus, setQueueStatus] = useState({ pending: 0, running: 0 })
  const lastInvalidatedTaskSignature = useRef<string>('')

  useEffect(() => {
    let throttleTimer: ReturnType<typeof setTimeout> | null = null

    const updateStatus = () => {
      const next =
        sessionId && sessionId !== 'new' ? computationQueue.getStatusForSession(sessionId) : { pending: 0, running: 0 }
      // Bail out with the previous object when nothing changed so React can
      // skip the re-render entirely.
      setQueueStatus((prev) => (prev.pending === next.pending && prev.running === next.running ? prev : next))
    }

    const onQueueChange = () => {
      if (throttleTimer) return
      throttleTimer = setTimeout(() => {
        throttleTimer = null
        updateStatus()
      }, QUEUE_STATUS_THROTTLE_MS)
    }

    updateStatus()
    const unsubscribe = computationQueue.subscribe(onQueueChange)
    return () => {
      unsubscribe()
      if (throttleTimer) clearTimeout(throttleTimer)
    }
  }, [sessionId])

  // The draft is tokenized synchronously (tiktoken); analyze it independently
  // of the context so streaming-chunk context churn never re-encodes it.
  const currentInputAnalysis = useMemo(
    () =>
      analyzeCurrentInputTokens({
        constructedMessage,
        tokenizerType,
        modelSupportToolUseForFile,
        sandboxMode,
      }),
    [constructedMessage, tokenizerType, modelSupportToolUseForFile, sandboxMode]
  )

  const contextAnalysis = useMemo(
    () =>
      analyzeContextTokens({
        contextMessages,
        tokenizerType,
        modelSupportToolUseForFile,
        sandboxMode,
      }),
    [contextMessages, tokenizerType, modelSupportToolUseForFile, sandboxMode]
  )

  const pendingAnalysisTasks = useMemo(
    () => [...currentInputAnalysis.pendingTasks, ...contextAnalysis.pendingTasks],
    [currentInputAnalysis.pendingTasks, contextAnalysis.pendingTasks]
  )

  const contextMessageIds = useMemo(() => new Set(contextMessages.map((m) => m.id)), [contextMessages])

  const pendingTaskIds = useMemo(() => {
    if (!sessionId || sessionId === 'new') return []
    return pendingAnalysisTasks.map((task) =>
      generateTaskId({
        ...task,
        sessionId,
      })
    )
  }, [pendingAnalysisTasks, sessionId])

  useEffect(() => {
    if (!sessionId || sessionId === 'new') return

    const pendingTaskSignature = pendingTaskIds.join('|')
    if (pendingTaskIds.length > 0 && pendingTaskSignature !== lastInvalidatedTaskSignature.current) {
      computationQueue.invalidateCompletedTasks(pendingTaskIds)
      lastInvalidatedTaskSignature.current = pendingTaskSignature
    }

    if (pendingTaskIds.length === 0) {
      lastInvalidatedTaskSignature.current = ''
    }

    // Cancel tasks for messages no longer in context (e.g., maxContextMessageCount changed)
    computationQueue.retainOnlyMessages(sessionId, contextMessageIds)

    // Cancel tasks with old tokenizerType when model changes
    computationQueue.retainOnlyTokenizerType(sessionId, tokenizerType)

    if (pendingAnalysisTasks.length === 0) return

    computationQueue.enqueueBatch(
      pendingAnalysisTasks.map((task) => ({
        ...task,
        sessionId,
      }))
    )
  }, [sessionId, contextMessageIds, pendingAnalysisTasks, pendingTaskIds, tokenizerType])

  useEffect(() => {
    return () => {
      if (sessionId && sessionId !== 'new') {
        computationQueue.cancelBySession(sessionId)
      }
    }
  }, [sessionId])

  const currentInputTokens =
    currentInputAnalysis.breakdown.text +
    currentInputAnalysis.breakdown.attachments +
    currentInputAnalysis.breakdown.toolCalls
  const contextTokens =
    contextAnalysis.breakdown.text + contextAnalysis.breakdown.attachments + contextAnalysis.breakdown.toolCalls

  const breakdown = useMemo(
    () => ({
      currentInput: currentInputAnalysis.breakdown,
      context: contextAnalysis.breakdown,
    }),
    [currentInputAnalysis.breakdown, contextAnalysis.breakdown]
  )

  return {
    currentInputTokens,
    contextTokens,
    totalTokens: currentInputTokens + contextTokens,
    isCalculating: queueStatus.pending > 0 || queueStatus.running > 0 || pendingAnalysisTasks.length > 0,
    pendingTasks: queueStatus.pending + queueStatus.running,
    breakdown,
  }
}
