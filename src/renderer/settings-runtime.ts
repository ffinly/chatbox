import { SettingsService } from '@shared/application/settings'
import type { LoggerPort } from '@shared/ports'
import { createSettingsStore } from '@shared/react-bindings/stores'
import { RendererSettingsEffects } from '@/adapters/RendererSettingsEffects'
import { RendererSettingsStorage } from '@/adapters/RendererSettingsStorage'
import platform from '@/platform'

// This module is reachable while `@/platform` itself is still being evaluated
// (platform -> remote -> vibedrop -> settings store -> this module). Keep every
// platform access behind a function so the ESM binding is only read after the
// platform singleton has finished initializing.
const settingsHost = {
  ensureShortcutConfig: (...args: Parameters<typeof platform.ensureShortcutConfig>) => {
    void platform.ensureShortcutConfig(...args)
  },
  ensureProxyConfig: (...args: Parameters<typeof platform.ensureProxyConfig>) => {
    void platform.ensureProxyConfig(...args)
  },
  ensureAutoLaunch: (...args: Parameters<typeof platform.ensureAutoLaunch>) => {
    void platform.ensureAutoLaunch(...args)
  },
}

const settingsLogger: LoggerPort = {
  log(level, message, context) {
    const contextSuffix = context === undefined ? '' : ` ${JSON.stringify(context)}`
    return platform.appLog(level, `${message}${contextSuffix}`)
  },
}

export const settingsStorage = new RendererSettingsStorage()
export const settingsService = new SettingsService(settingsStorage, {
  isDesktopLike: () => platform.isDesktopLike,
  logger: settingsLogger,
})
export const settingsStore = createSettingsStore(settingsService)

export const rendererSettingsEffects = new RendererSettingsEffects(settingsService, settingsHost)
rendererSettingsEffects.start()
