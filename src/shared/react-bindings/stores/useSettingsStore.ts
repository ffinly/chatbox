import { useStore } from 'zustand/react'
import type { SettingsStore, SettingsStoreState } from './createSettingsStore'
import { selectLanguage, selectMcpSettings, selectTheme } from './settings-selectors'

export function useSettingsStore<T>(store: SettingsStore, selector: (state: SettingsStoreState) => T): T {
  return useStore(store, selector)
}

export function createSettingsHooks(store: SettingsStore) {
  return {
    useSettingsStore<T>(selector: (state: SettingsStoreState) => T): T {
      return useSettingsStore(store, selector)
    },
    useLanguage() {
      return useSettingsStore(store, selectLanguage)
    },
    useTheme() {
      return useSettingsStore(store, selectTheme)
    },
    useMcpSettings() {
      return useSettingsStore(store, selectMcpSettings)
    },
  }
}
