import { finishAbortedGeneration } from '@shared/generation'
import type { Message } from '@shared/types'

export { cancelRunningToolCallBatch, finishAbortedGeneration } from '@shared/generation'

export interface GenerationCancellationPersistence {
  removeMessage: (sessionId: string, messageId: string) => Promise<void>
  persistMessage: (sessionId: string, message: Message) => Promise<void>
}

export async function stopGeneratingMessages(
  sessionId: string,
  messages: readonly Message[],
  persistence: GenerationCancellationPersistence,
  stoppedAt = Date.now()
): Promise<void> {
  for (const message of messages) {
    message.cancel?.(stoppedAt)
  }

  await Promise.all(
    messages.map((message) =>
      message.contentParts.length === 0
        ? persistence.removeMessage(sessionId, message.id)
        : persistence.persistMessage(sessionId, finishAbortedGeneration(message, message.contentParts, stoppedAt))
    )
  )
}
