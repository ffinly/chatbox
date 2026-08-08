import {
  AGENT_PROMPT_SNAPSHOT_VERSION,
  type AgentPromptSnapshot,
  MEMORY_ENTRY_MAX_CHARS,
  MEMORY_MAX_ENTRIES,
  type MemoryEntry,
  MemoryEntrySchema,
  SOUL_MAX_CHARS,
} from '@shared/types/agent-persona'
import { t } from 'i18next'
import { z } from 'zod'
import { buildWorkspaceInstructions, normalizeWorkspaceDirectory } from '@/packages/model-calls/workspace-instructions'
import storage from '@/storage'

/**
 * Global agent persona storage: the user's Soul document and agent-written memories.
 * Both are global (not per-session); running sessions read them only through the
 * frozen AgentPromptSnapshot in session settings, so writes here never disturb an
 * in-flight conversation or its provider prompt cache.
 */

export const AGENT_SOUL_STORAGE_KEY = 'agent-soul'
export const AGENT_MEMORIES_STORAGE_KEY = 'agent-memories'

const SoulRecordSchema = z.object({
  content: z.string().catch(''),
  updatedAt: z.number().catch(0),
})

type SoulRecord = z.infer<typeof SoulRecordSchema>

/**
 * Seed template, localized with the user's current UI language at first access.
 * Headings, blockquote guidance, and HTML comments are all scaffolding that
 * `extractSoulContent` strips, so an unedited template still falls back to the
 * default persona instead of injecting placeholder text.
 */
export function buildSoulTemplate(): string {
  return `# Soul

> ${t('This file defines who your Chatbox agent is. It is loaded when an agent session starts.')}
> ${t('Keep it short and sharp — operating rules belong in your workspace AGENTS.md, not here.')}

## ${t('Personality & Tone')}

<!-- ${t('e.g. Concise and direct. Has opinions. Skips filler like "Great question!"')} -->

## ${t('Principles')}

<!-- ${t('e.g. Be resourceful before asking. Verify before claiming something is done.')} -->

## ${t('Boundaries')}

<!-- ${t('e.g. Ask before any external or public action. Private things stay private.')} -->
`
}

export async function readSoul(): Promise<SoulRecord> {
  // BaseStorage.getItem persists the initialValue on first read, which seeds the
  // localized template exactly once.
  const raw = await storage.getItem<SoulRecord>(AGENT_SOUL_STORAGE_KEY, {
    content: buildSoulTemplate(),
    updatedAt: Date.now(),
  })
  const parsed = SoulRecordSchema.safeParse(raw)
  return parsed.success ? parsed.data : { content: '', updatedAt: 0 }
}

/**
 * Serialize read-modify-write mutations per storage key. Parallel save_memory
 * tool calls in one step, or a Settings deletion overlapping an agent write,
 * would otherwise both read the same old value and the last full-array write
 * would silently drop the other's change.
 */
function createMutationLock() {
  let chain: Promise<unknown> = Promise.resolve()
  return <T>(operation: () => Promise<T>): Promise<T> => {
    const run = chain.then(operation, operation)
    chain = run.catch(() => undefined)
    return run
  }
}

const withSoulLock = createMutationLock()
const withMemoriesLock = createMutationLock()

async function writeSoulRecord(content: string): Promise<SoulRecord> {
  const record: SoulRecord = {
    content: content.slice(0, SOUL_MAX_CHARS * 2),
    updatedAt: Date.now(),
  }
  await storage.setItemNow(AGENT_SOUL_STORAGE_KEY, record)
  return record
}

export function writeSoul(content: string): Promise<SoulRecord> {
  return withSoulLock(() => writeSoulRecord(content))
}

/** Atomic read-modify-write on the Soul document (virtual-file edit_file path). */
export function updateSoul(
  updater: (content: string) => string | { error: string }
): Promise<{ record: SoulRecord } | { error: string }> {
  return withSoulLock(async () => {
    const current = await readSoul()
    const next = updater(current.content)
    if (typeof next !== 'string') return next
    return { record: await writeSoulRecord(next) }
  })
}

const MemoriesRecordSchema = z.array(MemoryEntrySchema).catch([])

export async function listMemories(): Promise<MemoryEntry[]> {
  const raw = await storage.getItem<MemoryEntry[]>(AGENT_MEMORIES_STORAGE_KEY, [])
  return MemoriesRecordSchema.parse(raw)
}

function generateMemoryId(): string {
  return `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

export type AddMemoryResult = { ok: true; entry: MemoryEntry } | { ok: false; error: string }

export interface ImportMemoriesResult {
  imported: number
  skippedDuplicate: number
  skippedEmpty: number
  skippedTooLong: number
  skippedLimit: number
}

export function addMemory(content: string): Promise<AddMemoryResult> {
  return withMemoriesLock(async () => {
    const trimmed = content.trim()
    if (!trimmed) {
      return { ok: false, error: 'Memory content is empty.' }
    }
    if (trimmed.length > MEMORY_ENTRY_MAX_CHARS) {
      return { ok: false, error: `Memory content exceeds ${MEMORY_ENTRY_MAX_CHARS} characters. Save a shorter fact.` }
    }
    const memories = await listMemories()
    if (memories.some((entry) => entry.content === trimmed)) {
      return { ok: false, error: 'An identical memory already exists.' }
    }
    if (memories.length >= MEMORY_MAX_ENTRIES) {
      return {
        ok: false,
        error: `Memory limit of ${MEMORY_MAX_ENTRIES} entries reached. Delete stale entries with delete_memory first.`,
      }
    }
    const entry: MemoryEntry = { id: generateMemoryId(), content: trimmed, createdAt: Date.now() }
    await storage.setItemNow(AGENT_MEMORIES_STORAGE_KEY, [...memories, entry])
    return { ok: true, entry }
  })
}

export function deleteMemory(id: string): Promise<boolean> {
  return withMemoriesLock(async () => {
    const memories = await listMemories()
    const next = memories.filter((entry) => entry.id !== id)
    if (next.length === memories.length) return false
    await storage.setItemNow(AGENT_MEMORIES_STORAGE_KEY, next)
    return true
  })
}

export function importMemories(contents: string[]): Promise<ImportMemoriesResult> {
  return withMemoriesLock(async () => {
    const memories = await listMemories()
    const seen = new Set(memories.map((entry) => entry.content))
    const additions: MemoryEntry[] = []
    const result: ImportMemoriesResult = {
      imported: 0,
      skippedDuplicate: 0,
      skippedEmpty: 0,
      skippedTooLong: 0,
      skippedLimit: 0,
    }

    for (const content of contents) {
      const trimmed = content.trim()
      if (!trimmed) {
        result.skippedEmpty += 1
        continue
      }
      if (trimmed.length > MEMORY_ENTRY_MAX_CHARS) {
        result.skippedTooLong += 1
        continue
      }
      if (seen.has(trimmed)) {
        result.skippedDuplicate += 1
        continue
      }
      if (memories.length + additions.length >= MEMORY_MAX_ENTRIES) {
        result.skippedLimit += 1
        continue
      }
      seen.add(trimmed)
      additions.push({ id: generateMemoryId(), content: trimmed, createdAt: Date.now() })
    }

    if (additions.length > 0) {
      await storage.setItemNow(AGENT_MEMORIES_STORAGE_KEY, [...memories, ...additions])
    }
    result.imported = additions.length
    return result
  })
}

function normalizedDirectories(workingDirectories: string[] | undefined): string[] {
  return [
    ...new Set((workingDirectories ?? []).map(normalizeWorkspaceDirectory).filter((directory) => directory.length > 0)),
  ]
}

/** Capture a fresh frozen snapshot of the persona prompt inputs for a session. */
export async function captureAgentPromptSnapshot(
  workingDirectories: string[] | undefined,
  scope: 'chat' | 'agent'
): Promise<AgentPromptSnapshot> {
  const directories = normalizedDirectories(workingDirectories)
  const [soul, memories, workspaceInstructions] = await Promise.all([
    readSoul(),
    listMemories(),
    buildWorkspaceInstructions(workingDirectories),
  ])
  return {
    version: AGENT_PROMPT_SNAPSHOT_VERSION,
    soul: soul.content,
    memories,
    workspaceInstructions,
    workspaceDirectories: directories,
    capturedAt: Date.now(),
    scope,
  }
}

/** Serialize backup import (or similar bulk writes) against agent persona mutations. */
export function withAgentPersonaLocks<T>(operation: () => Promise<T>): Promise<T> {
  return withSoulLock(() => withMemoriesLock(operation))
}

/**
 * Whether an existing snapshot still applies to the session's current working
 * directories. Directory changes are user-explicit, so the snapshot is re-captured
 * (an acceptable, intentional prompt-cache break).
 */
export function snapshotMatchesDirectories(
  snapshot: AgentPromptSnapshot,
  workingDirectories: string[] | undefined
): boolean {
  const directories = normalizedDirectories(workingDirectories)
  return (
    snapshot.workspaceDirectories.length === directories.length &&
    snapshot.workspaceDirectories.every((dir, index) => dir === directories[index])
  )
}
