import { isExpectedGenerationError } from '@shared/models/error-classification'
import type { Message, ModelProvider } from '@shared/types'
import { createModel } from '@/adapters'
import { languageNameMap } from '@/i18n/locales'
import { generateText } from '@/packages/model-calls'
import * as promptFormat from '@/packages/prompts'
import { reportError } from '@/utils/sentry'
import * as chatStore from '../chatStore'
import { settingsStore } from '../settingsStore'
import { hasContentForAutoTitle } from './message-success'
import {
  activeNameGenerations,
  nameGenerationCooldownUntil,
  nameGenerationsDeferredUntilIdle,
  pendingNameGenerations,
} from './state'

/** Cooldown after a failed naming attempt when generation is already idle. */
const NAME_GENERATION_IDLE_COOLDOWN_MS = 60_000

export type ScheduleNameGenerationOptions = {
  /** Current session messages; used to clear defer-until-idle after streaming ends. */
  messages?: Message[]
}

/**
 * Modify session name and thread name
 */
export async function modifyNameAndThreadName(sessionId: string, name: string) {
  await chatStore.updateSession(sessionId, { name, threadName: name })
}

/**
 * Modify session's current thread name
 */
export async function modifyThreadName(sessionId: string, threadName: string) {
  await chatStore.updateSession(sessionId, { threadName })
}

/**
 * Internal function to generate a name for a session/thread.
 * @returns true when a non-empty name was persisted
 */
async function _generateName(
  sessionId: string,
  modifyName: (sessionId: string, name: string) => Promise<void>
): Promise<boolean> {
  const session = await chatStore.getSession(sessionId)
  const globalSettings = settingsStore.getState().getSettings()
  if (!session) {
    return false
  }
  const settings = {
    ...globalSettings,
    ...session.settings,
    ...(session.type === 'picture'
      ? {
          modelId: 'gpt-4o-mini',
        }
      : {}),
    ...(globalSettings.threadNamingModel
      ? {
          provider: globalSettings.threadNamingModel.provider as ModelProvider,
          modelId: globalSettings.threadNamingModel.model,
        }
      : {}),
  }
  try {
    const model = await createModel(settings)
    const result = await generateText(
      model,
      promptFormat.nameConversation(
        session.messages.filter((m) => m.role !== 'system').slice(0, 4),
        languageNameMap[settings.language]
      )
    )
    let name =
      result.contentParts
        ?.filter((c) => c.type === 'text')
        .map((c) => c.text)
        .join('') || ''
    name = name.replace(/['""\u201C\u201D]/g, '').replace(/<think>.*?<\/think>/g, '')
    if (!name.trim()) {
      return false
    }
    // The naming request can outlive the session (deleted mid-flight); writing
    // the name back would resurrect the deleted session's storage entry.
    if (!(await chatStore.getSession(sessionId))) {
      return false
    }
    await modifyName(sessionId, name)
    return true
  } catch (e: unknown) {
    if (!isExpectedGenerationError(e)) {
      reportError(e, {
        domain: 'ai-generation',
        operation: 'generate_session_name',
      })
    }
    return false
  }
}

/**
 * Generate session name and thread name
 */
async function generateNameAndThreadName(sessionId: string) {
  return await _generateName(sessionId, modifyNameAndThreadName)
}

/**
 * Generate thread name only
 */
async function generateThreadName(sessionId: string) {
  return await _generateName(sessionId, modifyThreadName)
}

/**
 * Re-check eligibility when the deferred timer fires.
 *
 * Scheduling can happen as soon as an assistant turn starts generating; by the
 * time we run, that turn may have ended as a cancel / error / agent-mode
 * suggestion, and we must not permanently title the session from that attempt.
 */
async function shouldGenerateSessionAndThreadName(sessionId: string): Promise<boolean> {
  const session = await chatStore.getSession(sessionId)
  if (!session || session.name !== 'Untitled') return false
  return hasContentForAutoTitle(session.messages)
}

async function shouldGenerateThreadName(sessionId: string): Promise<boolean> {
  const session = await chatStore.getSession(sessionId)
  if (!session || session.threadName) return false
  return hasContentForAutoTitle(session.messages)
}

function hasGeneratingMessage(messages: Message[] | undefined): boolean {
  return Boolean(messages?.some((message) => message.generating))
}

function isNameGenerationCoolingDown(key: string): boolean {
  const until = nameGenerationCooldownUntil.get(key)
  if (until == null) return false
  if (Date.now() >= until) {
    nameGenerationCooldownUntil.delete(key)
    return false
  }
  return true
}

function suppressFailedNameGenerationRetry(key: string, messages: Message[] | undefined) {
  if (hasGeneratingMessage(messages)) {
    // Streaming updates must not re-issue naming requests every second.
    nameGenerationsDeferredUntilIdle.add(key)
    return
  }
  nameGenerationCooldownUntil.set(key, Date.now() + NAME_GENERATION_IDLE_COOLDOWN_MS)
}

function canScheduleNameGeneration(key: string, options?: ScheduleNameGenerationOptions): boolean {
  if (activeNameGenerations.has(key) || pendingNameGenerations.has(key)) {
    return false
  }

  if (nameGenerationsDeferredUntilIdle.has(key)) {
    if (hasGeneratingMessage(options?.messages)) {
      return false
    }
    nameGenerationsDeferredUntilIdle.delete(key)
  }

  if (isNameGenerationCoolingDown(key)) {
    return false
  }

  return true
}

async function runScheduledNameGeneration(
  key: string,
  sessionId: string,
  shouldGenerate: (sessionId: string) => Promise<boolean>,
  generate: (sessionId: string) => Promise<boolean>
) {
  // Release the pending slot before the async eligibility check so a Header
  // update that becomes eligible again can schedule a replacement timer.
  // Only take the active lock once we are committed to calling the model.
  pendingNameGenerations.delete(key)

  if (!(await shouldGenerate(sessionId))) {
    return
  }

  if (activeNameGenerations.has(key)) {
    return
  }
  activeNameGenerations.add(key)

  try {
    const named = await generate(sessionId)

    // Failed or empty naming results must not be retried on every streaming
    // cache update — defer until generation settles, or cool down when idle.
    if (!named) {
      const session = await chatStore.getSession(sessionId)
      // A session deleted mid-flight has no retries to suppress; recording state
      // for it would undo clearSessionNameGenerationState's cleanup.
      if (session) {
        suppressFailedNameGenerationRetry(key, session.messages)
      }
    }
  } finally {
    activeNameGenerations.delete(key)
  }
}

/**
 * Schedule generating session name and thread name (with dedup and delay).
 *
 * Once scheduled, later session updates must not reset the timer — streaming /
 * agent-mode tool rounds would otherwise keep deferring the title indefinitely.
 */
export function scheduleGenerateNameAndThreadName(sessionId: string, options?: ScheduleNameGenerationOptions) {
  const key = `name-${sessionId}`

  if (!canScheduleNameGeneration(key, options)) {
    return
  }

  const timeout = setTimeout(() => {
    void runScheduledNameGeneration(key, sessionId, shouldGenerateSessionAndThreadName, generateNameAndThreadName)
  }, 1000)

  pendingNameGenerations.set(key, timeout)
}

/**
 * Schedule generating thread name (with dedup and delay).
 *
 * Same first-schedule-wins behavior as {@link scheduleGenerateNameAndThreadName}.
 */
export function scheduleGenerateThreadName(sessionId: string, options?: ScheduleNameGenerationOptions) {
  const key = `thread-${sessionId}`

  if (!canScheduleNameGeneration(key, options)) {
    return
  }

  const timeout = setTimeout(() => {
    void runScheduledNameGeneration(key, sessionId, shouldGenerateThreadName, generateThreadName)
  }, 1000)

  pendingNameGenerations.set(key, timeout)
}
