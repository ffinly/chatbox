import { QueryClient } from '@tanstack/react-query'

export function createChatQueryClient(): QueryClient {
  return new QueryClient()
}

export const queryClient = createChatQueryClient()

export default queryClient
