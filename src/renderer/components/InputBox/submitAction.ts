import type { SessionType } from '@shared/types'

export type SubmitAction =
  /** Send immediately through the normal submit path. */
  | 'send'
  /** A generation is running: enqueue instead of sending. */
  | 'queue'
  /** Idle but earlier messages are still queued: enqueue behind them and drain to keep send order. */
  | 'queue-resume'
  /** Submission is not possible right now. */
  | 'block'

export type SubmitControl = 'send' | 'queue' | 'stop'

export function getSubmitControl(params: {
  generating: boolean
  hasDraft: boolean
  canQueueDraft: boolean
  sessionType?: SessionType
  hasModel: boolean
}): SubmitControl {
  if (!params.generating) return 'send'
  return params.hasDraft && params.canQueueDraft && params.sessionType !== 'picture' && params.hasModel
    ? 'queue'
    : 'stop'
}

export function getSubmitAction(params: {
  generating: boolean
  needGenerating: boolean
  sessionType?: SessionType
  queueLength: number
  blockedForOtherReasons: boolean
  hasModel: boolean
}): SubmitAction {
  const { generating, needGenerating, sessionType, queueLength, blockedForOtherReasons, hasModel } = params
  if (sessionType === 'picture') return 'block'
  if (blockedForOtherReasons || !hasModel) return 'block'
  if (generating) {
    // "Insert without reply" during generation keeps its historical no-op behavior.
    if (!needGenerating) return 'block'
    return 'queue'
  }
  if (needGenerating && queueLength > 0) return 'queue-resume'
  return 'send'
}
