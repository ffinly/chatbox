import type { Message } from '@shared/types'

type MessageLayout = 'left' | 'bubble' | undefined

export function shouldRightAlignMessage(messageLayout: MessageLayout, role: Message['role']): boolean {
  return messageLayout === 'bubble' && role === 'user'
}

export function shouldReserveClassicMessageTrailingSpace(
  messageLayout: MessageLayout,
  role: Message['role'],
  showAvatar: boolean,
  isSmallScreen: boolean
): boolean {
  return messageLayout !== 'bubble' && (role === 'assistant' || role === 'user') && showAvatar && isSmallScreen
}
