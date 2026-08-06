import { settings as createDefaultSettings } from '@shared/defaults'
import type { SettingsRepositoryPort, SettingsUpdate } from '@shared/ports'
import type { Settings } from '@shared/types'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { CurrentSettingsRepository, type CurrentSettingsRepositoryBackend } from './CurrentSettingsRepository'

function createHarness() {
  let current = createDefaultSettings()
  const listeners = new Set<(settings: Settings, previousSettings: Settings) => void>()

  const backend: CurrentSettingsRepositoryBackend = {
    hydrate: vi.fn(() => Promise.resolve(current)),
    getSettings: vi.fn(() => current),
    updateSettings: vi.fn((update: SettingsUpdate) => {
      const previous = current
      const result = typeof update === 'function' ? update(current) : update
      current = { ...current, ...result }
      for (const listener of listeners) listener(current, previous)
    }),
    subscribe: vi.fn((listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }),
  }

  const repository: SettingsRepositoryPort = new CurrentSettingsRepository(backend)
  return {
    backend,
    getCurrent: () => current,
    repository,
  }
}

describe('CurrentSettingsRepository contract', () => {
  let harness: ReturnType<typeof createHarness>

  beforeEach(() => {
    harness = createHarness()
  })

  test('hydrates through the current settings store lifecycle', async () => {
    await expect(harness.repository.hydrate()).resolves.toEqual(harness.getCurrent())
    expect(harness.backend.hydrate).toHaveBeenCalledOnce()
  })

  test('returns the current settings snapshot', () => {
    expect(harness.repository.getSettings()).toEqual(harness.getCurrent())
    expect(harness.backend.getSettings).toHaveBeenCalledOnce()
  })

  test('supports partial and functional settings updates', () => {
    harness.repository.updateSettings({ language: 'zh-Hans' })
    harness.repository.updateSettings((current) => ({
      showWordCount: !current.showWordCount,
    }))

    expect(harness.getCurrent().language).toBe('zh-Hans')
    expect(harness.getCurrent().showWordCount).toBe(true)
  })

  test('forwards subscriptions and unsubscribe behavior', () => {
    const listener = vi.fn()
    const unsubscribe = harness.repository.subscribe(listener)

    harness.repository.updateSettings({ language: 'ja' })
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({ language: 'ja' }),
      expect.objectContaining({ language: 'en' })
    )

    unsubscribe()
    harness.repository.updateSettings({ language: 'ko' })
    expect(listener).toHaveBeenCalledOnce()
  })
})
