import { ForkService } from '@shared/application/session'
import { getReachableSessionMessages } from '@shared/session/generation-state'
import {
  buildCreateInactiveForkPatch,
  buildDeleteForkPatch,
  buildSwitchForkToPatch,
  findMessageLocation,
  forkTailStartIndex,
} from '@shared/session/message-forks'
import type { Message } from '@shared/types'
import { v4 as uuidv4 } from 'uuid'
import * as chatStore from '../chatStore'
import { guardSessionAction } from './action-guard'
import { generationRuntimeStore } from './generation-runtime'

const forkIdentity = {
  createId: uuidv4,
  now: Date.now,
}

const forkService = new ForkService(
  {
    updateSessionWithMessages: (sessionId, updater) =>
      chatStore.updateSessionWithMessages(sessionId, updater, { preserveCachedGeneratingMessages: true }),
  },
  forkIdentity
)

// Keep the existing lookup export stable for generation and message callers.
export { findMessageLocation }

// Every fork mutation is a full-session write and must pass
// `preserveCachedGeneratingMessages`: alternative replies stream outside the
// session generation lock with cache-only chunk updates, so a plain write would
// roll their visible content back to the last 2s persistence snapshot.

/** Create a new fork branch at the specified message. */
export function createNewFork(sessionId: string, forkMessageId: string) {
  return forkService.create(sessionId, forkMessageId)
}

/**
 * Create an inactive branch and return the isolated message path that should be
 * used to generate its first reply. Returns null when the fork point has no
 * active answer yet.
 */
export async function createInactiveFork(
  sessionId: string,
  forkMessageId: string,
  branchMessages: Message[]
): Promise<Message[] | null> {
  let branchContext: Message[] | null = null

  await chatStore.updateSessionWithMessages(
    sessionId,
    (session) => {
      if (!session) {
        throw new Error('Session not found')
      }

      const location = findMessageLocation(session, forkMessageId)
      if (!location) {
        return session
      }

      const patch = buildCreateInactiveForkPatch(session, forkMessageId, branchMessages, forkIdentity)
      if (!patch) {
        return session
      }

      branchContext = [...location.list.slice(0, forkTailStartIndex(location.list, location.index)), ...branchMessages]
      return { ...session, ...patch }
    },
    { preserveCachedGeneratingMessages: true }
  )

  return branchContext
}

/** Switch between fork branches. */
export async function switchFork(sessionId: string, forkMessageId: string, direction: 'next' | 'prev') {
  if (!(await guardSessionAction(sessionId, 'switch-fork'))) {
    return
  }
  return forkService.switch(sessionId, forkMessageId, direction)
}

/** Switch directly to a saved fork branch by its position. */
export async function switchForkTo(sessionId: string, forkMessageId: string, position: number) {
  if (!(await guardSessionAction(sessionId, 'switch-fork'))) {
    return
  }
  await chatStore.updateSessionWithMessages(
    sessionId,
    (session) => {
      if (!session) {
        throw new Error('Session not found')
      }
      const patch = buildSwitchForkToPatch(session, forkMessageId, position)
      return patch ? { ...session, ...patch } : session
    },
    { preserveCachedGeneratingMessages: true }
  )
}

/** Delete the current fork branch. */
export async function deleteFork(sessionId: string, forkMessageId: string) {
  if (!(await guardSessionAction(sessionId, 'delete-fork'))) {
    return
  }
  let removedMessageIds = new Set<string>()
  const discardRemovedRuntimes = () => {
    for (const messageId of removedMessageIds) {
      generationRuntimeStore.discard(sessionId, messageId, 'fork-deleted')
    }
  }
  await chatStore.updateSessionWithMessages(
    sessionId,
    (session) => {
      if (!session) {
        throw new Error('Session not found')
      }
      const patch = buildDeleteForkPatch(session, forkMessageId)
      if (!patch) return session

      const updated = { ...session, ...patch }
      const reachableAfter = new Set(getReachableSessionMessages(updated).map((message) => message.id))
      removedMessageIds = new Set(
        getReachableSessionMessages(session)
          .filter(
            (message) =>
              !reachableAfter.has(message.id) &&
              message.role === 'assistant' &&
              (message.generating || generationRuntimeStore.get(sessionId, message.id) !== undefined)
          )
          .map((message) => message.id)
      )
      return updated
    },
    {
      preserveCachedGeneratingMessages: true,
      onFullSessionPersisted: discardRemovedRuntimes,
    }
  )
}

/** Expand all fork branches into the current message list. @deprecated */
export function expandFork(sessionId: string, forkMessageId: string) {
  return forkService.expand(sessionId, forkMessageId)
}
