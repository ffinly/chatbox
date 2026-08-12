/**
 * This module contains all fundamental operations for chat sessions and messages.
 * It uses react-query for caching.
 * */

import type { SessionMetadataUpdate } from '@chatbox/core/application/session'
import type { SessionMetaRepositoryPort } from '@chatbox/core/ports'
import { QueryKeys } from '@chatbox/react/query'
import {
  type Message,
  type Session,
  type SessionMetaRecord,
  type SessionSettings,
  SessionSettingsSchema,
  type Updater,
} from '@shared/types'
import compact from 'lodash/compact'
import { useMemo } from 'react'
import { sessionHooks, sessionQueryBridge, sessionRepository, sessionService } from '@/session-runtime'
import * as defaults from '../../shared/defaults'
import { settingsStore, useSettingsStore } from './settingsStore'

export { QueryKeys }

// Compatibility facade: existing imports stay stable while implementation lives
// in the application service and React Query binding.
export async function getMetaStorage(): Promise<SessionMetaRepositoryPort> {
  await sessionService.initialize()
  return sessionRepository.meta
}

export const listSessionsMetaPage = sessionService.listSessionsMetaPage.bind(sessionService)
export const listArchivedSessionsMetaPage = sessionService.listArchivedSessionsMetaPage.bind(sessionService)
export const countSessionsMeta = sessionService.countSessionsMeta.bind(sessionService)
export const countArchivedSessionsMeta = sessionService.countArchivedSessionsMeta.bind(sessionService)
export const listAllSessionsMeta = sessionService.listAllSessionsMeta.bind(sessionService)
export const listArchivedSessionsMeta = sessionService.listArchivedSessionsMeta.bind(sessionService)
export const getCachedSessionsMeta = sessionQueryBridge.getCachedSessionsMeta.bind(sessionQueryBridge)
export const listSessionsMeta = sessionQueryBridge.listSessionsMeta.bind(sessionQueryBridge)
export const useSession = sessionHooks.useSession
export const useSessionList = sessionHooks.useSessionList
export const useArchivedSessionList = sessionHooks.useArchivedSessionList

export function updateSessionListData(updater: (items: SessionMetaRecord[]) => SessionMetaRecord[]): void {
  sessionQueryBridge.updateSessionListData(updater)
}

export async function refreshSessionListCache(): Promise<void> {
  sessionQueryBridge.resetSessionList(await sessionService.listSessionsMetaPage(0))
}

// MARK: session operations

export const getSession = sessionQueryBridge.getSession.bind(sessionQueryBridge)
export const createSession = sessionService.createSession.bind(sessionService)
export const updateSessionWithMessages = sessionService.updateSessionWithMessages.bind(sessionService)
export const updateSession = sessionService.updateSession.bind(sessionService) as (
  sessionId: string,
  updater: Updater<SessionMetadataUpdate>
) => Promise<Session>

// Cache-only writes remain a React Query read-model concern.
export async function updateSessionCache(sessionId: string, updater: Updater<Session>): Promise<void> {
  const session = await getSession(sessionId)
  if (!session) throw new Error(`Session ${sessionId} not found`)
  updateSessionCacheSync(sessionId, updater)
}

export function updateSessionCacheSync(sessionId: string, updater: Updater<Session>): void {
  sessionQueryBridge.updateSessionCache(sessionId, updater)
}

// Lazy import: message-queue.ts imports this module, so a static import would be circular.
async function clearMessageQueues(sessionIds: string[]): Promise<void> {
  const { clearQueue } = await import('./session/message-queue')
  for (const sessionId of sessionIds) clearQueue(sessionId)
}

export async function deleteSession(sessionId: string): Promise<void> {
  // Clear only after the deletion succeeded: queued messages are the sole copy
  // of the user's text, and a failed deletion leaves the session (and queue) alive.
  await sessionService.deleteSession(sessionId)
  await clearMessageQueues([sessionId])
}
export const archiveSession = sessionService.archiveSession.bind(sessionService)
export const archiveSessions = sessionService.archiveSessions.bind(sessionService)
export const restoreSession = sessionService.restoreSession.bind(sessionService)
export async function deleteSessions(sessionIds: string[]): Promise<void> {
  await sessionService.deleteSessions(sessionIds)
  await clearMessageQueues(sessionIds)
}

// MARK: session settings operations

function mergeDefaultSessionSettings(session: Session): SessionSettings {
  if (session.type === 'picture') {
    return SessionSettingsSchema.parse({
      ...defaults.pictureSessionSettings(),
      ...session.settings,
    })
  } else {
    return SessionSettingsSchema.parse({
      ...defaults.chatSessionSettings(),
      ...session.settings,
    })
  }
}
// session settings is copied from global settings when session is created, so no need to merge global settings here
export function useSessionSettings(sessionId: string | null) {
  const { session } = useSession(sessionId)
  const globalSettings = useSettingsStore((state) => state)

  const sessionSettings = useMemo(() => {
    if (!session) {
      return SessionSettingsSchema.parse(globalSettings)
    }
    return mergeDefaultSessionSettings(session)
  }, [session, globalSettings])

  return { sessionSettings }
}

export async function getSessionSettings(sessionId: string) {
  const session = await getSession(sessionId)
  if (!session) {
    const globalSettings = settingsStore.getState().getSettings()
    return SessionSettingsSchema.parse(globalSettings)
  }
  return mergeDefaultSessionSettings(session)
}

// MARK: message operations

// list messages
export async function listMessages(sessionId?: string | null): Promise<Message[]> {
  if (!sessionId) {
    return []
  }
  const session = await getSession(sessionId)
  if (!session) {
    return []
  }
  return session.messages
}

export async function insertMessage(sessionId: string, message: Message, previousId?: string) {
  await updateSessionWithMessages(sessionId, (session) => {
    if (!session) {
      throw new Error(`session ${sessionId} not found`)
    }

    if (previousId) {
      // Insert after the previous message, skipping any compaction summaries
      // anchored to it: a summary sits immediately after its boundary message
      // and nothing may come between the pair (see buildCompactionCommitPatch).
      const afterAnchoredSummaries = (messages: Message[], previousIndex: number): number => {
        let index = previousIndex + 1
        while (index < messages.length && messages[index].isSummary) {
          index += 1
        }
        return index
      }

      // try to find insert position in message list
      let previousIndex = session.messages.findIndex((m) => m.id === previousId)

      if (previousIndex >= 0) {
        if (session.messages.some((existing) => existing.id === message.id)) return session
        const insertIndex = afterAnchoredSummaries(session.messages, previousIndex)
        return {
          ...session,
          messages: [...session.messages.slice(0, insertIndex), message, ...session.messages.slice(insertIndex)],
        } satisfies Session
      }

      // try to find insert position in threads
      if (session.threads) {
        for (const thread of session.threads) {
          previousIndex = thread.messages.findIndex((m) => m.id === previousId)
          if (previousIndex >= 0) {
            if (thread.messages.some((existing) => existing.id === message.id)) return session
            const insertIndex = afterAnchoredSummaries(thread.messages, previousIndex)
            return {
              ...session,
              threads: session.threads.map((th) => {
                if (th.id === thread.id) {
                  return {
                    ...thread,
                    messages: [
                      ...thread.messages.slice(0, insertIndex),
                      message,
                      ...thread.messages.slice(insertIndex),
                    ],
                  }
                }
                return th
              }),
            } satisfies Session
          }
        }
      }
    }
    // no previous message, insert to tail of current thread
    if (session.messages.some((existing) => existing.id === message.id)) return session
    return {
      ...session,
      messages: [...session.messages, message],
    } satisfies Session
  })
}

export async function updateMessageCache(sessionId: string, messageId: string, updater: Updater<Message>) {
  return await updateMessage(sessionId, messageId, updater, true)
}

export async function updateMessages(sessionId: string, updater: Updater<Message[]>) {
  return await updateSessionWithMessages(sessionId, (session) => {
    if (!session) {
      throw new Error(`session ${sessionId} not found`)
    }
    const updated = compact(typeof updater === 'function' ? updater(session.messages) : updater)
    return {
      ...session,
      messages: updated,
    }
  })
}

export async function updateMessage(
  sessionId: string,
  messageId: string,
  updater: Updater<Message>,
  onlyUpdateCache?: boolean
) {
  const update = (session: Session | null | undefined): Session => {
    if (!session) {
      throw new Error(`session ${sessionId} not found`)
    }

    const updateMessages = (messages: Message[]) => {
      return messages.map((m) => {
        if (m.id !== messageId) {
          return m
        }
        const updated = typeof updater === 'function' ? updater(m) : updater
        return {
          ...m,
          ...updated,
        } satisfies Message
      })
    }
    const message = session.messages.find((m) => m.id === messageId)
    if (message) {
      return {
        ...session,
        messages: updateMessages(session.messages),
      }
    }

    // try find message in threads
    if (session.threads) {
      for (const thread of session.threads) {
        const message = thread.messages.find((m) => m.id === messageId)
        if (message) {
          return {
            ...session,
            threads: session.threads.map((th) => {
              if (th.id !== thread.id) {
                return th
              }
              return {
                ...th,
                messages: updateMessages(th.messages),
              }
            }),
          } satisfies Session
        }
      }
    }

    if (session.messageForksHash) {
      for (const [forkMessageId, fork] of Object.entries(session.messageForksHash)) {
        const listIndex = fork.lists.findIndex((list) => list.messages.some((message) => message.id === messageId))
        if (listIndex < 0) {
          continue
        }

        return {
          ...session,
          messageForksHash: {
            ...session.messageForksHash,
            [forkMessageId]: {
              ...fork,
              lists: fork.lists.map((list, index) =>
                index === listIndex
                  ? {
                      ...list,
                      messages: updateMessages(list.messages),
                    }
                  : list
              ),
            },
          },
        } satisfies Session
      }
    }

    return session
  }

  if (onlyUpdateCache) {
    await updateSessionCache(sessionId, update)
    return
  }

  await updateSessionWithMessages(sessionId, update, { preserveCachedGeneratingMessages: true })
}

export async function removeMessage(sessionId: string, messageId: string) {
  // Messages can be deleted while other replies stream; their cache-only chunk
  // updates must survive this full-session write. Preserving never resurrects
  // the removed message: the merge only maps over messages that still exist.
  return await updateSessionWithMessages(
    sessionId,
    (session) => {
      if (!session) {
        throw new Error(`session ${sessionId} not found`)
      }

      const messageToDelete =
        session.messages.find((m) => m.id === messageId) ??
        session.threads?.flatMap((thread) => thread.messages).find((m) => m.id === messageId) ??
        Object.values(session.messageForksHash ?? {})
          .flatMap((fork) => fork.lists)
          .flatMap((list) => list.messages)
          .find((m) => m.id === messageId)
      const isSummaryMessage = messageToDelete?.isSummary === true

      const newMessages = session.messages.filter((m) => m.id !== messageId)
      const newThreads = session.threads?.map((thread) => ({
        ...thread,
        messages: thread.messages.filter((m) => m.id !== messageId),
        compactionPoints: isSummaryMessage
          ? thread.compactionPoints?.filter((cp) => cp.summaryMessageId !== messageId)
          : thread.compactionPoints,
      }))

      const newCompactionPoints = isSummaryMessage
        ? session.compactionPoints?.filter((cp) => cp.summaryMessageId !== messageId)
        : session.compactionPoints

      // Clean up empty fork branches after message removal and auto-switch if needed
      const { messages: finalMessages, messageForksHash: newMessageForksHash } = cleanupEmptyForkBranches(
        removeMessageFromSavedForks(session.messageForksHash, messageId),
        newMessages,
        newThreads
      )

      return {
        ...session,
        messages: finalMessages,
        threads: newThreads,
        messageForksHash: newMessageForksHash,
        compactionPoints: newCompactionPoints,
      }
    },
    { preserveCachedGeneratingMessages: true }
  )
}

function removeMessageFromSavedForks(
  messageForksHash: Session['messageForksHash'],
  messageId: string
): Session['messageForksHash'] {
  if (!messageForksHash) {
    return undefined
  }

  const nextHash: NonNullable<Session['messageForksHash']> = {}
  for (const [forkMessageId, fork] of Object.entries(messageForksHash)) {
    const removedListIndex = fork.lists.findIndex((list) => list.messages.some((message) => message.id === messageId))
    if (removedListIndex < 0) {
      nextHash[forkMessageId] = fork
      continue
    }

    const removedBranchBecomesEmpty =
      removedListIndex !== fork.position && fork.lists[removedListIndex].messages.length === 1
    const updatedLists = fork.lists
      .map((list) => ({
        ...list,
        messages: list.messages.filter((message) => message.id !== messageId),
      }))
      .filter((list, index) => index === fork.position || list.messages.length > 0)

    if (updatedLists.length <= 1) {
      continue
    }

    nextHash[forkMessageId] = {
      ...fork,
      position: removedBranchBecomesEmpty && removedListIndex < fork.position ? fork.position - 1 : fork.position,
      lists: updatedLists,
    }
  }

  return Object.keys(nextHash).length > 0 ? nextHash : undefined
}

/**
 * Clean up empty fork branches after message removal.
 * If the current branch (messages after forkMessageId) is empty, remove it from the fork
 * and automatically switch to another branch by loading its messages.
 */
function cleanupEmptyForkBranches(
  messageForksHash: Session['messageForksHash'],
  messages: Message[],
  threads: Session['threads']
): { messages: Message[]; messageForksHash: Session['messageForksHash'] } {
  if (!messageForksHash) {
    return { messages, messageForksHash }
  }

  let resultHash: Session['messageForksHash'] = messageForksHash
  let resultMessages = messages

  for (const [forkMessageId, forkEntry] of Object.entries(messageForksHash)) {
    // Check if fork point exists in messages
    const forkIndexInMessages = resultMessages.findIndex((m) => m.id === forkMessageId)

    if (forkIndexInMessages >= 0) {
      // Fork is in main messages - check if tail is empty fork point 是 user msg，之后的 bot msg 是具体的分叉
      // 当用户这条消息(fork point)是最后一条消息，后面没了 bot msg，则当前分支是空的
      const currentBranchIsEmpty = forkIndexInMessages === resultMessages.length - 1

      if (currentBranchIsEmpty) {
        // Remove current branch from lists
        const remainingLists = forkEntry.lists.filter((_, index) => index !== forkEntry.position)

        if (remainingLists.length <= 1) {
          // Only one or zero branches left - remove the fork and load remaining messages
          const remainingBranchMessages = remainingLists[0]?.messages ?? []
          // Append remaining branch messages after the fork point
          resultMessages = resultMessages.slice(0, forkIndexInMessages + 1).concat(remainingBranchMessages)
          // Remove this fork from hash
          const { [forkMessageId]: _removed, ...rest } = resultHash ?? {}
          resultHash = Object.keys(rest).length ? rest : undefined
        } else {
          // Multiple branches remain - switch to nearest position and load its messages
          const newPosition = Math.min(forkEntry.position, remainingLists.length - 1)
          const newBranchMessages = remainingLists[newPosition]?.messages ?? []

          // Load the new branch's messages
          resultMessages = resultMessages.slice(0, forkIndexInMessages + 1).concat(newBranchMessages)

          // Clear the messages from the loaded branch (since they're now in main messages)
          const updatedLists = remainingLists.map((list, index) =>
            index === newPosition ? { ...list, messages: [] } : list
          )

          resultHash = {
            ...resultHash,
            [forkMessageId]: {
              ...forkEntry,
              position: newPosition,
              lists: updatedLists,
            },
          }
        }
      }
    } else if (threads) {
      // Fork might be in threads - just update the hash without modifying main messages
      for (const thread of threads) {
        const forkIndexInThread = thread.messages.findIndex((m) => m.id === forkMessageId)
        if (forkIndexInThread >= 0) {
          const currentBranchIsEmpty = forkIndexInThread === thread.messages.length - 1
          if (currentBranchIsEmpty) {
            const remainingLists = forkEntry.lists.filter((_, index) => index !== forkEntry.position)
            if (remainingLists.length <= 1) {
              const { [forkMessageId]: _removed, ...rest } = resultHash ?? {}
              resultHash = Object.keys(rest).length ? rest : undefined
            } else {
              const newPosition = Math.min(forkEntry.position, remainingLists.length - 1)
              resultHash = {
                ...resultHash,
                [forkMessageId]: {
                  ...forkEntry,
                  position: newPosition,
                  lists: remainingLists,
                },
              }
            }
          }
          break
        }
      }
    }
  }

  return { messages: resultMessages, messageForksHash: resultHash }
}

// MARK: data recovery operations

/**
 * Recover session list by scanning all session: prefixed keys in storage
 * This will clear the current session list and rebuild it from all found sessions
 */
export function recoverSessionList() {
  return sessionService.recoverSessionList()
}
