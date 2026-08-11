import { z } from 'zod'

/** Max characters of Soul content injected into the system prompt (truncated with a marker beyond this). */
export const SOUL_MAX_CHARS = 16_000
/** Max number of stored memory entries. */
export const MEMORY_MAX_ENTRIES = 100
/** Max characters for a single memory entry. */
export const MEMORY_ENTRY_MAX_CHARS = 1_000
/** Max total characters of memory content injected into the system prompt. */
export const MEMORY_PROMPT_MAX_CHARS = 8_000

export const MemoryEntrySchema = z.object({
  id: z.string(),
  content: z.string(),
  createdAt: z.number(),
})

export type MemoryEntry = z.infer<typeof MemoryEntrySchema>

/**
 * Frozen per-conversation snapshot of the reusable prompt-context inputs. It is
 * captured when the conversation first needs Soul, memories, or workspace
 * instructions. Mid-conversation edits update their source storage but never mutate
 * the snapshot, so the provider-side prompt cache prefix stays stable. A new thread
 * clears the snapshot and re-captures on the next generation.
 */
export const SessionPromptContextSnapshotSchema = z.object({
  version: z.number(),
  soul: z.string(),
  memories: z.array(MemoryEntrySchema),
  workspaceInstructions: z.string(),
  // The working directories the workspace instructions were captured for. When the
  // session's directories change, the workspace part is re-captured (user-explicit
  // change, an acceptable cache break).
  workspaceDirectories: z.array(z.string()),
  capturedAt: z.number(),
  // Which mode captured the snapshot. Agent mode only trusts 'agent'-scoped
  // snapshots (a chat-scoped one predates "first agent generation", so Soul
  // edits made before enabling Work Mode must still apply); chat mode accepts
  // both. Missing scope means a pre-scope agent-mode snapshot.
  scope: z.enum(['chat', 'agent']).optional().catch(undefined),
})

export type SessionPromptContextSnapshot = z.infer<typeof SessionPromptContextSnapshotSchema>

export const SESSION_PROMPT_CONTEXT_SNAPSHOT_VERSION = 1

/**
 * Virtual path exposing the Soul document to file tools (read_file / write_file /
 * edit_file). Backed by app storage, not the filesystem; the explicit scheme avoids
 * colliding with real SOUL.md files in user directories.
 */
export const SOUL_VIRTUAL_PATH = 'chatbox://SOUL.md'
