import { boundCopilotPersona } from '@shared/agent-persona/prompt'
import type { Message, SessionPromptContextSnapshot, SessionSettings } from '@shared/types'
import type { MemoryScope } from '@shared/types/agent-persona'
import { getMessageText } from '@shared/utils/message'
import {
  captureSessionPromptContextSnapshot,
  listMemoriesForScope,
  sessionPromptContextSnapshotMatchesDirectories,
} from '@/stores/agentPersonaStore'

export interface ResolveSessionPromptContextSnapshotOptions {
  effectiveAgentMode: 'on' | 'off'
  /** Memory switch for this request (global or the session copilot's); when off, chat mode never captures. */
  memoryEnabled: boolean
  /** Which memory store this session reads; defaults to the global one. */
  memoryScope?: MemoryScope
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

/** Whether a snapshot's memories came from the store the session currently uses. */
function snapshotMatchesMemoryScope(snapshot: SessionPromptContextSnapshot, memoryScope: MemoryScope): boolean {
  return memoryScope.type === 'copilot'
    ? snapshot.memoryCopilotId === memoryScope.copilotId
    : snapshot.memoryCopilotId === undefined
}

/**
 * Resolve the frozen prompt-context snapshot (Soul + Copilot overlay + memories +
 * workspace AGENTS.md) for one generation. Captured once and reused verbatim
 * afterwards so the system prompt prefix stays byte-stable for provider caches.
 *
 * Agent mode: only trusts 'agent'-scoped snapshots — a chat-scoped one was
 * captured before the session's first agent generation, and Soul edits made in
 * between must still apply (missing scope means a pre-scope agent snapshot).
 * A working-directory change is user-explicit, so it re-captures; so is a
 * memory-scope change (copilot memory toggled), which re-captures from the
 * store the session now uses.
 *
 * Chat mode: reads memories (no Soul/identity) through the same snapshot and
 * accepts either scope. Capture happens only at conversation start (before the
 * first assistant turn) and only when memories exist — memories appearing
 * mid-conversation, including ones this very session just saved via
 * save_memory, apply to future conversations only, exactly as the tool
 * description promises; sessions that never touch memories get no snapshot
 * churn. A snapshot whose memory scope no longer matches (copilot memory
 * toggled mid-conversation) keeps everything but its memories, so the frozen
 * conversation-start anchor still pins the prompt prefix; the new store joins at
 * the next conversation start, mirroring how the global switch behaves.
 */
export async function resolveSessionPromptContextSnapshot(
  options: ResolveSessionPromptContextSnapshotOptions
): Promise<SessionPromptContextSnapshot | undefined> {
  const { effectiveAgentMode, memoryEnabled, settings, messages, targetMsgIx, persist, copilotId } = options
  const memoryScope = options.memoryScope ?? { type: 'global' }
  const existing = settings.sessionPromptContextSnapshot

  if (effectiveAgentMode === 'on') {
    if (
      existing &&
      (existing.scope ?? 'agent') === 'agent' &&
      sessionPromptContextSnapshotMatchesDirectories(existing, settings.workingDirectories) &&
      snapshotMatchesMemoryScope(existing, memoryScope)
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
    const captured = await captureSessionPromptContextSnapshot(settings.workingDirectories, 'agent', memoryScope)
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

  const isConversationStart = !messages.slice(0, targetMsgIx).some((message) => message.role === 'assistant')
  if (existing) {
    if (snapshotMatchesMemoryScope(existing, memoryScope)) return existing
    // The other store's memories must not leak into this conversation, but the
    // rest of the snapshot still anchors the system prompt (capture instant and
    // UTC offset): dropping it outright would move the frozen date line and
    // invalidate the provider prefix cache mid-conversation. The new store is
    // recorded even though nothing is re-captured, so a tool call this generation
    // pauses is continued against the store its tools were built for.
    if (!isConversationStart) {
      const rescoped: SessionPromptContextSnapshot = { ...existing, memories: [] }
      if (memoryScope.type === 'copilot') rescoped.memoryCopilotId = memoryScope.copilotId
      else delete rescoped.memoryCopilotId
      persist?.(rescoped)
      return rescoped
    }
  }
  if (memoryEnabled && isConversationStart && (await listMemoriesForScope(memoryScope)).length > 0) {
    const snapshot = await captureSessionPromptContextSnapshot(settings.workingDirectories, 'chat', memoryScope)
    persist?.(snapshot)
    return snapshot
  }
  return undefined
}
