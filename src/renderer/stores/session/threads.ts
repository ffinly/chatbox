import { ThreadService } from '@shared/application/session'
import * as defaults from '@shared/defaults'
import type { SessionThread } from '@shared/types'
import { v4 as uuidv4 } from 'uuid'
import * as dom from '@/hooks/dom'
import * as chatStore from '../chatStore'
import * as scrollActions from '../scrollActions'
import { _copySession as copySession, switchCurrentSession } from './crud'

const threadService = new ThreadService({
  sessions: {
    getSession: (sessionId) => chatStore.getSession(sessionId),
    updateSession: (sessionId, updater) => chatStore.updateSession(sessionId, updater),
    updateSessionWithMessages: (sessionId, updater) => chatStore.updateSessionWithMessages(sessionId, updater),
  },
  createId: uuidv4,
  now: Date.now,
  getDefaultSystemPrompt: defaults.getDefaultPrompt,
  cancelMessages: (_sessionId, messages) => {
    for (const message of messages) message.cancel?.()
  },
  copySession: (source) => copySession(source),
})

export function editThread(sessionId: string, threadId: string, newThread: Pick<Partial<SessionThread>, 'name'>) {
  return threadService.edit(sessionId, threadId, newThread)
}

export function removeThread(sessionId: string, threadId: string) {
  return threadService.remove(sessionId, threadId)
}

export async function switchThread(sessionId: string, threadId: string) {
  if (await threadService.switch(sessionId, threadId)) {
    setTimeout(() => scrollActions.scrollToBottom('smooth'), 300)
  }
}

export function refreshContextAndCreateNewThread(sessionId: string) {
  return threadService.refreshContextAndCreateNew(sessionId)
}

export async function startNewThread(sessionId: string) {
  await threadService.refreshContextAndCreateNew(sessionId)
  setTimeout(() => {
    scrollActions.scrollToBottom()
    dom.focusMessageInput()
  }, 100)
}

export function removeCurrentThread(sessionId: string) {
  return threadService.removeCurrent(sessionId)
}

export async function compressAndCreateThread(sessionId: string, summary: string) {
  if (await threadService.compressAndCreate(sessionId, summary)) {
    setTimeout(() => {
      scrollActions.scrollToBottom()
      dom.focusMessageInput()
    }, 100)
  }
}

export async function moveThreadToConversations(sessionId: string, threadId: string) {
  const newSessionId = await threadService.moveToConversation(sessionId, threadId)
  if (newSessionId) switchCurrentSession(newSessionId)
}

export async function moveCurrentThreadToConversations(sessionId: string) {
  const newSessionId = await threadService.moveCurrentToConversation(sessionId)
  if (newSessionId) switchCurrentSession(newSessionId)
}
