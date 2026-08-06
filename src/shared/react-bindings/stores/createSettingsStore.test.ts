import { describe, expect, test } from 'vitest'
import { SettingsService } from '../../application/settings'
import type { SettingsStoragePort } from '../../ports'
import { createSettingsStore } from './createSettingsStore'

class MemorySettingsStorage implements SettingsStoragePort {
  value: unknown = null

  read() {
    return Promise.resolve(this.value)
  }

  write(value: unknown) {
    this.value = value
    return Promise.resolve()
  }

  remove() {
    this.value = null
    return Promise.resolve()
  }
}

describe('createSettingsStore', () => {
  test('projects hydration and routes compatibility setState through SettingsService', async () => {
    const storage = new MemorySettingsStorage()
    const service = new SettingsService(storage, { isDesktopLike: false })
    const store = createSettingsStore(service)

    await store.getState().hydrate()
    expect(store.getState().hydrationStatus).toBe('hydrated')

    store.setState({ language: 'ja' })
    store.setState((state) => {
      state.showWordCount = true
    })
    store.getState().setSettings((settings) => {
      settings.theme = 1
    })
    await service.flushPersistence()

    expect(service.getSettings()).toMatchObject({
      language: 'ja',
      showWordCount: true,
      theme: 1,
    })
    expect(storage.value).toMatchObject({
      language: 'ja',
      showWordCount: true,
      theme: 1,
      __version: 5,
    })

    store.getState().destroy()
    service.dispose()
  })
})
