import { describe, expect, test } from 'vitest'
import { shouldBuildElectronViteTarget } from '../../electron.vite.config'

describe('shouldBuildElectronViteTarget', () => {
  test('builds every target when no target is requested', () => {
    expect(shouldBuildElectronViteTarget('main', undefined)).toBe(true)
    expect(shouldBuildElectronViteTarget('preload', undefined)).toBe(true)
    expect(shouldBuildElectronViteTarget('renderer', undefined)).toBe(true)
  })

  test('builds only the requested target', () => {
    expect(shouldBuildElectronViteTarget('main', 'renderer')).toBe(false)
    expect(shouldBuildElectronViteTarget('preload', 'renderer')).toBe(false)
    expect(shouldBuildElectronViteTarget('renderer', 'renderer')).toBe(true)
  })

  test('rejects an invalid target', () => {
    expect(() => shouldBuildElectronViteTarget('main', 'desktop')).toThrow(
      'Invalid CHATBOX_ELECTRON_VITE_TARGET "desktop"',
    )
  })
})
