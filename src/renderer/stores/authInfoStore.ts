import {
  type AuthInfoStoreState,
  type AuthTokens,
  createAuthInfoStore,
  useAuthInfoStore as useSharedAuthInfoStore,
} from '@shared/react-bindings/stores'
import { getSafeStorage } from './safeStorage'

export type { AuthTokens }

export const authInfoStore = createAuthInfoStore({
  storage: getSafeStorage(),
})

export function useAuthInfoStore<T>(selector: (state: AuthInfoStoreState) => T): T {
  return useSharedAuthInfoStore(authInfoStore, selector)
}

export function useAuthTokens() {
  return useAuthInfoStore(({ accessToken, refreshToken, setTokens, clearTokens, getTokens }) => ({
    accessToken,
    refreshToken,
    setTokens,
    clearTokens,
    getTokens,
  }))
}
