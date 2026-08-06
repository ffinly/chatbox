import type { SettingsRepositoryPort, SettingsUpdate } from '@shared/ports'
import type { Settings } from '@shared/types'
import { initSettingsStore, settingsService } from '@/stores/settingsStore'

export interface CurrentSettingsRepositoryBackend {
  hydrate(): Promise<Settings>
  getSettings(): Settings
  updateSettings(update: SettingsUpdate): void
  subscribe(listener: (settings: Settings, previousSettings: Settings) => void): () => void
}

function createCurrentBackend(): CurrentSettingsRepositoryBackend {
  return {
    hydrate: initSettingsStore,
    getSettings: () => settingsService.getSettings(),
    updateSettings: (update) => settingsService.updateSettings(update),
    subscribe: (listener) => settingsService.subscribe(listener),
  }
}

/**
 * Compatibility adapter over the shared SettingsService.
 */
export class CurrentSettingsRepository implements SettingsRepositoryPort {
  constructor(private readonly backend: CurrentSettingsRepositoryBackend = createCurrentBackend()) {}

  hydrate(): Promise<Settings> {
    return this.backend.hydrate()
  }

  getSettings(): Settings {
    return this.backend.getSettings()
  }

  updateSettings(update: SettingsUpdate): void {
    this.backend.updateSettings(update)
  }

  subscribe(listener: (settings: Settings, previousSettings: Settings) => void): () => void {
    return this.backend.subscribe(listener)
  }
}
