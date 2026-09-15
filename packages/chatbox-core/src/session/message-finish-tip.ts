import type { Message } from '../types'

export function getMessageFinishTip(
  message: Pick<Message, 'role' | 'generating' | 'finishReason' | 'error' | 'errorCode'>,
  t: (key: string) => string
): string | undefined {
  if (message.role !== 'assistant' || message.generating) return undefined

  switch (message.finishReason) {
    case 'content-filter':
      return t('The response was interrupted by the provider’s content safety filter. Try rephrasing your request.')
    case 'length':
      return t('Length limit reached. Send “Continue” to ask the model to keep going.')
    case 'error':
      return message.error || message.errorCode
        ? undefined
        : t('The response was interrupted by an error. Please try again.')
    default:
      return undefined
  }
}
