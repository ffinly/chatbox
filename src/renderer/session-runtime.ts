import { SessionEventBus, SessionService, SessionWriteCoordinator } from '@shared/application/session'
import { v4 as uuidv4 } from 'uuid'
import { CurrentSessionRepository } from '@/adapters/CurrentSessionRepository'
import { getLogger } from '@/lib/utils'
import { createSessionHooks } from '@/react-bindings/query/session-hooks'
import { SessionQueryBridge } from '@/react-bindings/query/session-query-bridge'
import { lastUsedModelStore } from '@/stores/lastUsedModelStore'
import queryClient from '@/stores/queryClient'

export const sessionRepository = new CurrentSessionRepository()
const sessionLogger = getLogger('session-service')
export const sessionEvents = new SessionEventBus(sessionLogger)

let sessionQueryBridgeReference: SessionQueryBridge | null = null

export const sessionWriteCoordinator = new SessionWriteCoordinator(sessionRepository, {
  readCurrentSession: (sessionId) =>
    sessionQueryBridgeReference
      ? sessionQueryBridgeReference.getSession(sessionId)
      : sessionRepository.getSession(sessionId),
})

export const sessionService = new SessionService(sessionRepository, sessionWriteCoordinator, sessionEvents, {
  createId: uuidv4,
  logger: sessionLogger,
  getLastUsedModels: () => lastUsedModelStore.getState(),
  getVisibleSessionMetas: () => sessionQueryBridgeReference?.getCachedSessionsMeta() ?? [],
})

export const sessionQueryBridge = new SessionQueryBridge(queryClient, sessionService, sessionEvents)
sessionQueryBridgeReference = sessionQueryBridge

export const sessionHooks = createSessionHooks(sessionQueryBridge.definitions)
