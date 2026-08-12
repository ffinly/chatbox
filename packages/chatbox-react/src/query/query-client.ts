import { QueryClient } from '@tanstack/react-query'

/**
 * Creates a host-owned QueryClient.
 *
 * Shared bindings deliberately expose a factory rather than a singleton so
 * Electron, Web, Capacitor, and React Native can each provide their own cache.
 */
export function createChatQueryClient(): QueryClient {
  return new QueryClient()
}
