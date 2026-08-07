import type { ModelMessage } from 'ai'
import { isExpectedGenerationError } from '../../models/error-classification'
import type { ModelInterface } from '../../models/types'
import type { ModelFactoryPort, SettingsRepositoryPort } from '../../ports'
import { nameConversation } from '../../prompts'
import { hasContentForAutoTitle } from '../../session/message-success'
import type { Language, Message, ModelProvider, Session, SessionSettings, Settings } from '../../types'
import type { SessionUseCasePort } from './session-use-case-port'

export interface ScheduledNameGeneration {
  cancel(): void
}

export interface NameGenerationSchedulerPort {
  schedule(callback: () => void, delayMs: number): ScheduledNameGeneration
}

export interface SessionNamingServiceDependencies {
  sessions: Pick<SessionUseCasePort, 'getSession' | 'updateSession'>
  settings: Pick<SettingsRepositoryPort, 'getSettings'>
  models: ModelFactoryPort
  scheduler: NameGenerationSchedulerPort
  getLanguageName(language: Language): string
  toModelMessages(messages: Message[], model: ModelInterface): Promise<ModelMessage[]>
  reportUnexpectedError(error: unknown): void
}

export interface SessionNameGenerationOptions {
  locale?: Language
  /** Current messages let failed streaming attempts stay deferred until the reply settles. */
  messages?: Message[]
}

const NAME_GENERATION_IDLE_COOLDOWN_MS = 60_000

export class SessionNamingService {
  private readonly pending = new Map<string, ScheduledNameGeneration>()
  private readonly active = new Set<string>()
  private readonly deferredUntilIdle = new Set<string>()
  private readonly cooldownUntil = new Map<string, number>()

  constructor(private readonly dependencies: SessionNamingServiceDependencies) {}

  async modifyNameAndThreadName(sessionId: string, name: string): Promise<void> {
    await this.dependencies.sessions.updateSession(sessionId, { name, threadName: name })
  }

  async modifyThreadName(sessionId: string, threadName: string): Promise<void> {
    await this.dependencies.sessions.updateSession(sessionId, { threadName })
  }

  generateNameAndThreadName(sessionId: string, locale?: Language): Promise<boolean> {
    return this.generate(sessionId, (id, name) => this.modifyNameAndThreadName(id, name), locale)
  }

  generateThreadName(sessionId: string, locale?: Language): Promise<boolean> {
    return this.generate(sessionId, (id, name) => this.modifyThreadName(id, name), locale)
  }

  scheduleNameAndThreadName(sessionId: string, options: SessionNameGenerationOptions = {}): void {
    this.schedule(
      `name-${sessionId}`,
      sessionId,
      (session) => session.name === 'Untitled' && hasContentForAutoTitle(session.messages),
      () => this.generateNameAndThreadName(sessionId, options.locale),
      options.messages
    )
  }

  scheduleThreadName(sessionId: string, options: SessionNameGenerationOptions = {}): void {
    this.schedule(
      `thread-${sessionId}`,
      sessionId,
      (session) => !session.threadName && hasContentForAutoTitle(session.messages),
      () => this.generateThreadName(sessionId, options.locale),
      options.messages
    )
  }

  clearSessionState(sessionId: string): void {
    for (const key of [`name-${sessionId}`, `thread-${sessionId}`]) {
      this.pending.get(key)?.cancel()
      this.pending.delete(key)
      this.deferredUntilIdle.delete(key)
      this.cooldownUntil.delete(key)
    }
  }

  isPending(key: string): boolean {
    return this.pending.has(key)
  }

  isActive(key: string): boolean {
    return this.active.has(key)
  }

  private schedule(
    key: string,
    sessionId: string,
    isEligible: (session: Session) => boolean,
    generate: () => Promise<boolean>,
    messages?: Message[]
  ): void {
    if (!this.canSchedule(key, messages)) return

    const task = this.dependencies.scheduler.schedule(() => {
      void this.runScheduled(key, sessionId, isEligible, generate)
    }, 1_000)
    this.pending.set(key, task)
  }

  private canSchedule(key: string, messages?: Message[]): boolean {
    // Once scheduled, later Session updates must not reset the timer. Streaming
    // chunks and agent-mode tool rounds could otherwise defer naming forever.
    if (this.active.has(key) || this.pending.has(key)) return false

    if (this.deferredUntilIdle.has(key)) {
      if (messages?.some((message) => message.generating)) return false
      this.deferredUntilIdle.delete(key)
    }

    const cooldownUntil = this.cooldownUntil.get(key)
    if (cooldownUntil !== undefined) {
      if (Date.now() < cooldownUntil) return false
      this.cooldownUntil.delete(key)
    }

    return true
  }

  private async runScheduled(
    key: string,
    sessionId: string,
    isEligible: (session: Session) => boolean,
    generate: () => Promise<boolean>
  ): Promise<void> {
    // Release pending before the async eligibility read so a later, eligible
    // renderer update can schedule a replacement attempt.
    this.pending.delete(key)
    const session = await this.dependencies.sessions.getSession(sessionId)
    if (!session || !isEligible(session) || this.active.has(key)) return

    this.active.add(key)
    try {
      if (await generate()) return

      const current = await this.dependencies.sessions.getSession(sessionId)
      if (!current) return
      if (current.messages.some((message) => message.generating)) {
        this.deferredUntilIdle.add(key)
      } else {
        this.cooldownUntil.set(key, Date.now() + NAME_GENERATION_IDLE_COOLDOWN_MS)
      }
    } finally {
      this.active.delete(key)
    }
  }

  private async generate(
    sessionId: string,
    modifyName: (sessionId: string, name: string) => Promise<void>,
    locale?: Language
  ): Promise<boolean> {
    const session = await this.dependencies.sessions.getSession(sessionId)
    const globalSettings = this.dependencies.settings.getSettings()
    if (!session) return false

    const settings = this.buildSettings(session, globalSettings)
    try {
      const model = await this.dependencies.models.createModel(settings)
      const language = locale ?? globalSettings.language
      const prompt = nameConversation(
        session.messages.filter((message) => message.role !== 'system').slice(0, 4),
        this.dependencies.getLanguageName(language)
      )
      const result = await model.chat(await this.dependencies.toModelMessages(prompt, model), {})
      const name = (result.contentParts ?? [])
        .filter((part) => part.type === 'text')
        .map((part) => part.text)
        .join('')
        .replace(/['"\u201C\u201D]/g, '')
        .replace(/<think>.*?<\/think>/g, '')
      if (!name.trim()) return false
      // The model call can outlive a deletion. Re-check before write-back so a
      // naming response cannot recreate a deleted Session.
      if (!(await this.dependencies.sessions.getSession(sessionId))) return false
      await modifyName(sessionId, name)
      return true
    } catch (error: unknown) {
      if (!isExpectedGenerationError(error)) {
        this.dependencies.reportUnexpectedError(error)
      }
      return false
    }
  }

  private buildSettings(session: Session, globalSettings: Settings): SessionSettings {
    return {
      ...globalSettings,
      ...session.settings,
      ...(session.type === 'picture' ? { modelId: 'gpt-4o-mini' } : {}),
      ...(globalSettings.threadNamingModel
        ? {
            provider: globalSettings.threadNamingModel.provider as ModelProvider,
            modelId: globalSettings.threadNamingModel.model,
          }
        : {}),
    }
  }
}
