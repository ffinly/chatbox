import type { Message } from '@shared/types'
import type { ModelMessage } from 'ai'
import { getLogger } from '@/lib/utils'
import {
  clearPendingSteerRequests,
  releaseInFlightQueuedMessage,
  removeQueuedMessage,
  takeRequestedSteerableMessage,
} from './message-queue'

const log = getLogger('steering')

// Only one generation per session may consume queued messages for steering.
// Alternative replies generate concurrently; first-wins keeps a queued message
// from being injected into two streams at once.
const activeConsumers = new Map<string, symbol>()

export interface SteeringConsumer {
  /**
   * Called from prepareStep with the messages the SDK is about to send.
   * Returns the messages to use for this step, or undefined to leave them unchanged.
   */
  inject(stepMessages: ModelMessage[]): Promise<ModelMessage[] | undefined>
  release(): void
}

interface ConsumedRecord {
  /**
   * Insertion index into the effective message array at consumption time.
   *
   * Coordinate invariant: prepareStep overrides do not enter the SDK's
   * accumulated response messages, so every later step receives the base
   * conversation plus only the SDK's own appended step output. The base
   * grows strictly at the tail, which means re-splicing earlier records in
   * ascending index order restores each steered message to its original
   * position: after the request context it interrupted, before the
   * assistant output of that step.
   */
  index: number
  modelMessage: ModelMessage
}

function toModelMessage(text: string): ModelMessage {
  return { role: 'user', content: [{ type: 'text', text }] }
}

function getMessageText(contentParts: { type: string; text?: string }[]): string {
  return contentParts
    .filter((part) => part.type === 'text')
    .map((part) => part.text ?? '')
    .join('\n')
}

/**
 * Register the current generation as the steering consumer for this session.
 * Returns null when another generation already holds the role.
 *
 * `conversationMessageIds` are the ids of the generation's own conversation
 * (fork/thread) — only queue items anchored there may be consumed, so an
 * inactive fork's generation cannot steal a message queued for another fork.
 *
 * `persistSteeredMessage` must durably insert the steered user message into the
 * session (anchored after the previous steered message or the prompt
 * predecessor) before it is shown to the model.
 */
export function registerSteeringConsumer(
  sessionId: string,
  anchorMessageId: string,
  conversationMessageIds: ReadonlySet<string>,
  persistSteeredMessage: (message: Message, afterMessageId: string) => Promise<void>
): SteeringConsumer | null {
  if (activeConsumers.has(sessionId)) return null
  const token = Symbol('steering-consumer')
  activeConsumers.set(sessionId, token)

  const records: ConsumedRecord[] = []
  const steeredIds = new Set<string>()
  let anchorId = anchorMessageId

  return {
    async inject(stepMessages: ModelMessage[]): Promise<ModelMessage[] | undefined> {
      const effective = [...stepMessages]
      for (const record of records) {
        effective.splice(record.index, 0, record.modelMessage)
      }

      let consumed = false
      while (true) {
        // Only items the user explicitly asked to jump the queue are injected;
        // everything else waits for this reply to finish and is delivered in
        // order, one per generation.
        const head = takeRequestedSteerableMessage(
          sessionId,
          (queuedAnchorId) => conversationMessageIds.has(queuedAnchorId) || steeredIds.has(queuedAnchorId)
        )
        if (!head) break
        const text = getMessageText(head.message.contentParts)
        try {
          // Persist first: the model must never see a message the session lost.
          // The item stays queued (in-flight) until this write lands, so a
          // crash mid-persist cannot lose it.
          await persistSteeredMessage({ ...head.message, generating: false, steered: true }, anchorId)
        } catch (error) {
          log.error('Failed to persist steered message, leaving it queued:', error)
          releaseInFlightQueuedMessage(sessionId, head.id)
          break
        }
        removeQueuedMessage(sessionId, head.id)
        anchorId = head.message.id
        steeredIds.add(head.message.id)
        records.push({ index: effective.length, modelMessage: toModelMessage(text) })
        effective.push(toModelMessage(text))
        consumed = true
      }

      if (!consumed && records.length === 0) return undefined
      return effective
    },
    release() {
      if (activeConsumers.get(sessionId) === token) {
        activeConsumers.delete(sessionId)
        // The generation these requests targeted is over; the items now simply
        // deliver in order, so the "interjecting" state must not linger.
        clearPendingSteerRequests(sessionId)
      }
    },
  }
}

export function resetSteeringForTests(): void {
  activeConsumers.clear()
}
