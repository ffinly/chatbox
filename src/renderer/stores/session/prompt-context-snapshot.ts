import type { Message, SessionPromptContextSnapshot, SessionSettings } from '@shared/types'
import { boundCopilotPersona } from '@shared/agent-persona/prompt'
import { getMessageText } from '@shared/utils/message'
import {
  captureSessionPromptContextSnapshot,
  listMemories,
  sessionPromptContextSnapshotMatchesDirectories,
} from '@/stores/agentPersonaStore'

export interface ResolveSessionPromptContextSnapshotOptions {
  effectiveAgentMode: 'on' | 'off'
  /** Global memory switch for this request; when off, chat mode never captures. */
  memoryEnabled: boolean
  settings: SessionSettings
  messages: Message[]
  targetMsgIx: number
  persist?: (snapshot: SessionPromptContextSnapshot) => void
  /** When set, the session system prompt is frozen into Soul as a Copilot overlay. */
  copilotId?: string
}

export function extractCopilotPersona(messages: Message[], targetMsgIx: number): string | undefined {
  const systemMessage = messages.slice(0, targetMsgIx).find((message) => message.role === 'system')
  const text = systemMessage ? getMessageText(systemMessage, false, false) : ''
  return boundCopilotPersona(text)
}

/**
 * Resolve the frozen prompt-context snapshot (Soul + Copilot overlay + memories +
 * workspace AGENTS.md) for one generation. Captured once and reused verbatim
 * afterwards so the system prompt prefix stays byte-stable for provider caches.
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
export async function resolveSessionPromptContextSnapshot(
  options: ResolveSessionPromptContextSnapshotOptions
): Promise<SessionPromptContextSnapshot | undefined> {
  const { effectiveAgentMode, memoryEnabled, settings, messages, targetMsgIx, persist, copilotId } = options
  const existing = settings.sessionPromptContextSnapshot

  if (effectiveAgentMode === 'on') {
    if (
      existing &&
      (existing.scope ?? 'agent') === 'agent' &&
      sessionPromptContextSnapshotMatchesDirectories(existing, settings.workingDirectories)
    ) {
      return existing
    }
    const hasLegacyCommandHistory = messages
      .slice(0, targetMsgIx)
      .some((message) =>
        message.contentParts.some(
          (part) => part.type === 'tool-call' && (part.toolName === 'user_exec' || part.toolName === 'code_execution')
        )
      )
    const captured = await captureSessionPromptContextSnapshot(settings.workingDirectories, 'agent')
    const copilotPersona = copilotId ? extractCopilotPersona(messages, targetMsgIx) : undefined
    const snapshot = {
      ...captured,
      agentToolContractVersion:
        existing?.agentToolContractVersion ??
        (hasLegacyCommandHistory ? (1 as const) : (captured.agentToolContractVersion ?? (1 as const))),
      ...(copilotPersona ? { copilotPersona } : {}),
    }
    persist?.(snapshot)
    return snapshot
  }

  if (existing) return existing
  const isConversationStart = !messages.slice(0, targetMsgIx).some((message) => message.role === 'assistant')
  if (memoryEnabled && isConversationStart && (await listMemories()).length > 0) {
    const snapshot = await captureSessionPromptContextSnapshot(settings.workingDirectories, 'chat')
    persist?.(snapshot)
    return snapshot
  }
  return undefined
}
