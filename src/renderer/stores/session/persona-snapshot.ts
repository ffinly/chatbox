import type { AgentPromptSnapshot, Message, SessionSettings } from '@shared/types'
import { captureAgentPromptSnapshot, listMemories, snapshotMatchesDirectories } from '@/stores/agentPersonaStore'

export interface ResolvePersonaSnapshotOptions {
  effectiveAgentMode: 'on' | 'off'
  /** Global memory switch for this request; when off, chat mode never captures. */
  memoryEnabled: boolean
  settings: SessionSettings
  messages: Message[]
  targetMsgIx: number
  persist?: (snapshot: AgentPromptSnapshot) => void
}

/**
 * Resolve the frozen persona snapshot (Soul + memories + workspace AGENTS.md)
 * for one generation. Captured once and reused verbatim afterwards so the
 * system prompt prefix stays byte-stable for provider caches.
 *
 * Agent mode: only trusts 'agent'-scoped snapshots — a chat-scoped one was
 * captured before the session's first agent generation, and Soul edits made in
 * between must still apply (missing scope means a pre-scope agent snapshot).
 * A working-directory change is user-explicit, so it re-captures.
 *
 * Chat mode: reads memories (no Soul/identity) through the same snapshot and
 * accepts either scope. Capture happens only at conversation start (before the
 * first assistant turn) and only when memories exist — memories appearing
 * mid-conversation, including ones this very session just saved via
 * save_memory, apply to future conversations only, exactly as the tool
 * description promises; sessions that never touch memories get no snapshot
 * churn.
 */
export async function resolvePersonaSnapshot(
  options: ResolvePersonaSnapshotOptions
): Promise<AgentPromptSnapshot | undefined> {
  const { effectiveAgentMode, memoryEnabled, settings, messages, targetMsgIx, persist } = options
  const existing = settings.agentPromptSnapshot

  if (effectiveAgentMode === 'on') {
    if (
      existing &&
      (existing.scope ?? 'agent') === 'agent' &&
      snapshotMatchesDirectories(existing, settings.workingDirectories)
    ) {
      return existing
    }
    const snapshot = await captureAgentPromptSnapshot(settings.workingDirectories, 'agent')
    persist?.(snapshot)
    return snapshot
  }

  if (existing) return existing
  const isConversationStart = !messages.slice(0, targetMsgIx).some((message) => message.role === 'assistant')
  if (memoryEnabled && isConversationStart && (await listMemories()).length > 0) {
    const snapshot = await captureAgentPromptSnapshot(settings.workingDirectories, 'chat')
    persist?.(snapshot)
    return snapshot
  }
  return undefined
}
