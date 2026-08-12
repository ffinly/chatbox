import { rendererApplication } from '@/app/renderer-application'

/** Compatibility facade for the host-owned application graph. */
export const sessionRepository = rendererApplication.sessions.repository
export const sessionEvents = rendererApplication.sessionEvents
export const sessionWriteCoordinator = rendererApplication.sessionWrites
export const sessionService = rendererApplication.sessions
export const sessionQueryBridge = rendererApplication.sessionQueryBridge
export const sessionHooks = rendererApplication.sessionHooks
