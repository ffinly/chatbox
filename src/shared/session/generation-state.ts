import type { Message, Session } from '../types'

type GenerationStateMessage = Pick<Message, 'id' | 'role' | 'generating'>
const EMPTY_ACTIVE_GENERATION_MESSAGE_IDS: ReadonlySet<string> = new Set()

export function isCancellableGeneratingAssistantMessage(
  message: GenerationStateMessage,
  generationRuntimeActive: boolean
): boolean {
  return message.role === 'assistant' && message.generating === true && generationRuntimeActive
}

export function countCancellableGeneratingAssistantMessages(
  messages: GenerationStateMessage[],
  activeGenerationMessageIds: ReadonlySet<string>
): number {
  return messages.reduce(
    (count, message) =>
      count + Number(isCancellableGeneratingAssistantMessage(message, activeGenerationMessageIds.has(message.id))),
    0
  )
}

function collectReachableMessages(session: Session, initialLists: Message[][]): Message[] {
  const messages: Message[] = []
  const seenMessageIds = new Set<string>()
  const visitedForkIds = new Set<string>()
  const pendingLists = [...initialLists]

  while (pendingLists.length > 0) {
    const list = pendingLists.shift()
    if (!list) {
      continue
    }

    for (const message of list) {
      if (!seenMessageIds.has(message.id)) {
        seenMessageIds.add(message.id)
        messages.push(message)
      }

      const fork = session.messageForksHash?.[message.id]
      if (!fork || visitedForkIds.has(message.id)) {
        continue
      }
      visitedForkIds.add(message.id)
      for (const branch of fork.lists) {
        pendingLists.push(branch.messages)
      }
    }
  }

  return messages
}

/** Return every message reachable from the active conversation or a historical thread. */
export function getReachableSessionMessages(session: Session): Message[] {
  return collectReachableMessages(session, [
    session.messages,
    ...(session.threads ?? []).map((thread) => thread.messages),
  ])
}

/**
 * Return messages reachable from the current conversation, including saved
 * fork branches but excluding historical threads.
 */
export function getConversationMessages(session: Session, messages: Message[]): Message[] {
  return collectReachableMessages(session, [messages])
}

export function getCurrentConversationMessages(session: Session): Message[] {
  return getConversationMessages(session, session.messages)
}

type GenerationControlBase = {
  currentMessageIds: ReadonlySet<string>
  visibleMessages: Message[]
}

// Several consumers derive lock state from the same Session snapshot in one
// render pass. Cache the runtime-independent traversal per Session identity;
// runtime ids are still filtered fresh whenever the store changes.
const generationControlBaseCache = new WeakMap<Session, GenerationControlBase>()

function getGenerationControlBase(session: Session): GenerationControlBase {
  const cached = generationControlBaseCache.get(session)
  if (cached) return cached

  const currentMessages = getCurrentConversationMessages(session)
  const result = {
    currentMessageIds: new Set(currentMessages.map((message) => message.id)),
    visibleMessages: getReachableSessionMessages(session),
  }
  generationControlBaseCache.set(session, result)
  return result
}

/**
 * Return messages that should control the session-level generating UI.
 *
 * Current conversation messages keep their existing behavior, including the
 * short placeholder window before an AbortController is registered. Historical
 * threads and their forks are included only while their message id has an active
 * runtime, so stale persisted `generating: true` flags cannot lock the session.
 */
export function getGenerationControlMessages(
  session: Session,
  activeGenerationMessageIds: ReadonlySet<string> = EMPTY_ACTIVE_GENERATION_MESSAGE_IDS
): Message[] {
  const { currentMessageIds, visibleMessages } = getGenerationControlBase(session)

  return visibleMessages.filter(
    (message) =>
      currentMessageIds.has(message.id) ||
      isCancellableGeneratingAssistantMessage(message, activeGenerationMessageIds.has(message.id))
  )
}
