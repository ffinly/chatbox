import { listPendingApprovalToolCalls } from '../message-approval'
import type { Session, SessionType } from '../types'
import { countCancellableGeneratingAssistantMessages, getGenerationControlMessages } from './generation-state'

/**
 * Pure lock/gate decisions for session actions while replies stream, a
 * compaction summary runs, or a tool call waits for user approval.
 *
 * This module is the single source of truth for "is this action allowed right
 * now, and if not, why". Hosts (web renderer, mobile-native, a future CLI)
 * derive a `SessionLockState` snapshot, ask `getSessionActionGate` before
 * running an action, and map the returned reason to their own copy and
 * presentation (toast, tooltip, disabled control, CLI error). UI components
 * must not encode their own blocking conditions.
 */

export type SessionLockState = {
  /** Assistant replies currently streaming with a live cancel callback. */
  generatingReplyCount: number
  /**
   * Any reply in the current conversation still flagged as generating,
   * including the short placeholder window before an AbortController is
   * registered. Drives the send-vs-stop switch and blocks new submissions.
   */
  anyReplyGenerating: boolean
  /** A compaction summary is streaming for this session. */
  compactionRunning: boolean
  /** A tool call in the current message list waits for user approval. */
  awaitingToolApproval: boolean
}

export const IDLE_SESSION_LOCK_STATE: SessionLockState = {
  generatingReplyCount: 0,
  anyReplyGenerating: false,
  compactionRunning: false,
  awaitingToolApproval: false,
}

export type SessionActionBlockReason =
  /** Other replies in the session are still streaming. */
  | 'generating'
  /** A compaction summary is streaming. */
  | 'compaction'
  /** A tool call waits for user approval. */
  | 'awaiting-approval'
  /** The target message itself is still streaming. */
  | 'message-streaming'

export type SessionActionGate =
  | { allowed: true; reason?: undefined }
  | { allowed: false; reason: SessionActionBlockReason }

export type SessionAction =
  /** Reply Again / retry, whole message or last tool step — regenerate-class. */
  | 'regenerate'
  /** Open the message editor for a plain save. */
  | 'edit-message'
  /** The editor's Save & Resend variant — regenerate-class. */
  | 'save-and-resend'
  /** Delete a compaction summary message. */
  | 'delete-summary'
  /** Switch the active fork branch. */
  | 'switch-fork'
  /** Delete a fork branch. */
  | 'delete-fork'
  /** Submit a new user message. */
  | 'submit-message'

export type SessionActionContext = {
  /** Whether the message the action targets is itself still streaming. */
  messageGenerating?: boolean
}

const ALLOWED: SessionActionGate = { allowed: true }

function blocked(reason: SessionActionBlockReason): SessionActionGate {
  return { allowed: false, reason }
}

/**
 * Build the lock snapshot from session data plus runtime flags the host
 * tracks outside the session (compaction progress lives in host state, not on
 * the persisted session).
 */
export function deriveSessionLockState(
  session: Session,
  runtime: { compactionRunning?: boolean } = {}
): SessionLockState {
  const controlMessages = getGenerationControlMessages(session)
  return {
    generatingReplyCount: countCancellableGeneratingAssistantMessages(controlMessages),
    anyReplyGenerating: controlMessages.some((message) => message.generating === true),
    compactionRunning: runtime.compactionRunning ?? false,
    awaitingToolApproval: listPendingApprovalToolCalls(session.messages).length > 0,
  }
}

export function isGenerationLocked(locks: SessionLockState): boolean {
  return locks.generatingReplyCount > 0
}

/**
 * Value equality for lock snapshots. Hosts that re-derive the snapshot on
 * every data change (e.g. per streaming chunk) can reuse the previous object
 * when nothing changed, keeping memoized consumers stable.
 */
export function sessionLockStatesEqual(a: SessionLockState, b: SessionLockState): boolean {
  return (
    a.generatingReplyCount === b.generatingReplyCount &&
    a.anyReplyGenerating === b.anyReplyGenerating &&
    a.compactionRunning === b.compactionRunning &&
    a.awaitingToolApproval === b.awaitingToolApproval
  )
}

export function getSessionActionGate(
  action: SessionAction,
  locks: SessionLockState,
  context: SessionActionContext = {}
): SessionActionGate {
  const generationLocked = isGenerationLocked(locks)
  switch (action) {
    case 'regenerate':
      return generationLocked ? blocked('generating') : ALLOWED
    case 'edit-message':
      // Plain saves are safe while other replies stream (writes are serialized
      // and the in-flight context was snapshotted at generation start); only a
      // still-streaming target blocks editing, because a saved snapshot would
      // be silently overwritten by the next chunk.
      return context.messageGenerating ? blocked('message-streaming') : ALLOWED
    case 'save-and-resend':
      if (context.messageGenerating) {
        return blocked('message-streaming')
      }
      return generationLocked ? blocked('generating') : ALLOWED
    case 'delete-summary':
      return generationLocked ? blocked('generating') : ALLOWED
    case 'switch-fork':
    case 'delete-fork':
      // Switching or deleting branches while a compaction summary streams
      // would move the pending boundary off the active path and waste the
      // summary run (commit would route it back to the stored branch).
      if (generationLocked) {
        return blocked('generating')
      }
      return locks.compactionRunning ? blocked('compaction') : ALLOWED
    case 'submit-message':
      if (locks.anyReplyGenerating) {
        return blocked('generating')
      }
      if (locks.compactionRunning) {
        return blocked('compaction')
      }
      return locks.awaitingToolApproval ? blocked('awaiting-approval') : ALLOWED
  }
}

export function shouldShowConcurrentReplyStop(options: {
  /**
   * Explicit opt-in used by fork-group alternatives. The active reply in the
   * main list must stay button-free while generating; it is stopped from the
   * input box instead.
   */
  allowStop: boolean
  cancellable: boolean
  generatingReplyCount: number
  sessionType: SessionType
}): boolean {
  return (
    options.allowStop && options.cancellable && options.generatingReplyCount > 1 && options.sessionType !== 'picture'
  )
}
