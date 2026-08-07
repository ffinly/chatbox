import { SessionNamingService } from '@shared/application/session'
import type { Message } from '@shared/types'
import { currentModelFactory } from '@/adapters/CurrentModelFactory'
import { languageNameMap } from '@/i18n/locales'
import { convertToModelMessages } from '@/packages/model-calls/message-utils'
import { settingsService } from '@/settings-runtime'
import { reportError } from '@/utils/sentry'
import * as chatStore from '../chatStore'

const namingService = new SessionNamingService({
  sessions: {
    getSession: (sessionId) => chatStore.getSession(sessionId),
    updateSession: (sessionId, updater) => chatStore.updateSession(sessionId, updater),
  },
  settings: settingsService,
  models: currentModelFactory,
  scheduler: {
    schedule(callback, delayMs) {
      const timeout = setTimeout(callback, delayMs)
      return { cancel: () => clearTimeout(timeout) }
    },
  },
  getLanguageName: (language) => languageNameMap[language],
  toModelMessages: (messages, model) =>
    convertToModelMessages(messages, { modelSupportVision: model.isSupportVision() }),
  reportUnexpectedError: (error) => {
    reportError(error, {
      domain: 'ai-generation',
      operation: 'generate_session_name',
    })
  },
})

export function modifyNameAndThreadName(sessionId: string, name: string) {
  return namingService.modifyNameAndThreadName(sessionId, name)
}

export function modifyThreadName(sessionId: string, threadName: string) {
  return namingService.modifyThreadName(sessionId, threadName)
}

export type ScheduleNameGenerationOptions = {
  messages?: Message[]
}

export function scheduleGenerateNameAndThreadName(sessionId: string, options?: ScheduleNameGenerationOptions) {
  namingService.scheduleNameAndThreadName(sessionId, { messages: options?.messages })
}

export function scheduleGenerateThreadName(sessionId: string, options?: ScheduleNameGenerationOptions) {
  namingService.scheduleThreadName(sessionId, { messages: options?.messages })
}

export function clearSessionNameGenerationState(sessionId: string): void {
  namingService.clearSessionState(sessionId)
}
