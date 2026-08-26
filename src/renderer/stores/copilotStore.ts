import type { CopilotDetail } from '@shared/types'
import type { MemoryScope, SessionPromptContextSnapshot } from '@shared/types/agent-persona'
import { getDefaultStore } from 'jotai'
import { atomWithStorage } from 'jotai/utils'
import storage, { StorageKey } from '@/storage'
import { copilotMemoryEpoch, retireCopilotMemories } from './agentPersonaStore'

/** Copilots whose chats keep their own memory list instead of the global one. */
export const COPILOT_MEMORY_OWNERS_STORAGE_KEY = 'copilot-memory-owners'

export interface CopilotMemoryOwner {
  id: string
  /** Label for Settings; a saved copilot's live name wins over this snapshot. */
  name: string
}

/**
 * An `atomWithStorage` that also keeps its current value in a module-level mirror.
 * Persistence through `storage.setItem` is debounced and the atom only touches
 * storage once a React component subscribes, so non-React callers (generation
 * resolving a session's memory scope) read the mirror to see UI edits that have
 * not been written out yet.
 */
function createMirroredListAtom<T>(key: string) {
  let current: T[] | undefined
  let pendingRead: Promise<T[]> | undefined

  /** Load the persisted list once; a write landing meanwhile is newer and wins. */
  const read = (storageKey: string = key, initialValue: T[] = []): Promise<T[]> => {
    if (current !== undefined) return Promise.resolve(current)
    pendingRead ??= storage
      .getItem<T[]>(storageKey, initialValue)
      .then((stored) => {
        if (current === undefined) current = stored
        return current
      })
      .finally(() => {
        pendingRead = undefined
      })
    return pendingRead
  }

  const listAtom = atomWithStorage<T[]>(key, [], {
    getItem: read,
    setItem(storageKey: string, value: T[]): Promise<void> {
      current = value
      return storage.setItem(storageKey, value)
    },
    removeItem(storageKey: string): Promise<void> {
      current = []
      return storage.removeItem(storageKey)
    },
  })

  const update = (updater: (items: T[]) => T[]): Promise<void> => {
    const store = getDefaultStore()
    if (current !== undefined) return store.set(listAtom, updater(current))
    // One hydration read resolves for every mutation waiting on it, so build on the
    // mirror rather than that shared value: otherwise the second mutation restarts
    // from the pre-hydration list and drops the first.
    return read().then((items) => store.set(listAtom, updater(current ?? items)))
  }

  return { atom: listAtom, read, update }
}

const myCopilots = createMirroredListAtom<CopilotDetail>(StorageKey.MyCopilots)
const memoryOwners = createMirroredListAtom<CopilotMemoryOwner>(COPILOT_MEMORY_OWNERS_STORAGE_KEY)

export const myCopilotsAtom = myCopilots.atom
export const copilotMemoryOwnersAtom = memoryOwners.atom

export function addOrUpdateMyCopilot(target: CopilotDetail): Promise<void> {
  return myCopilots.update((copilots) => {
    const existingIndex = copilots.findIndex((copilot) => copilot.id === target.id)
    if (existingIndex === -1) {
      return [{ ...target, createdAt: Date.now(), updatedAt: Date.now() }, ...copilots]
    }
    return copilots.map((copilot, index) =>
      index === existingIndex ? { ...copilot, ...target, updatedAt: Date.now() } : copilot
    )
  })
}

export async function removeMyCopilot(id: string): Promise<void> {
  // Both mirrors update synchronously once hydrated. Start both mutations before
  // awaiting their debounced persistence so a new generation can no longer resolve
  // the copilot's memory scope while deletion is in progress.
  await Promise.all([
    myCopilots.update((copilots) => copilots.filter((copilot) => copilot.id !== id)),
    disableCopilotMemory(id),
  ])
  await retireCopilotMemories(id)
}

/**
 * Give a copilot its own memory list. Ownership is tracked per copilot id rather
 * than on the My Copilots entry, so a copilot used straight from the store — or a
 * built-in one that was never saved — keeps memories just the same.
 */
export function enableCopilotMemory(owner: CopilotMemoryOwner): Promise<void> {
  return memoryOwners.update((owners) => [...owners.filter((item) => item.id !== owner.id), owner])
}

/** Fall back to global memory; the copilot's own entries stay for a later re-enable. */
export function disableCopilotMemory(copilotId: string): Promise<void> {
  return memoryOwners.update((owners) => owners.filter((owner) => owner.id !== copilotId))
}

/** Wait for persisted ownership before initializing an editable UI draft. */
export async function readCopilotMemoryEnabled(copilotId: string): Promise<boolean> {
  const owners = await memoryOwners.read()
  return owners.some((owner) => owner.id === copilotId)
}

/**
 * Resolve the scope for a call produced by an earlier generation and only now being
 * executed. A tool call paused on the step limit is continued whenever the user gets
 * around to it — the app may have restarted in between — so the store the
 * conversation froze wins over the one the session resolves to today: resolving live
 * would let a copilot's `save_memory` land in global memory once that copilot is
 * deleted or its memory switched off, and would pull a global conversation into a
 * copilot list that only gained its own memory afterwards.
 *
 * A chat conversation only captures a snapshot once its store holds something, so a
 * copilot's very first memory has no frozen store to go back to; there the session's
 * current scope is the whole record.
 */
export function getPausedCallMemoryScope(
  snapshot: SessionPromptContextSnapshot | undefined,
  sessionCopilotId: string | undefined
): Promise<MemoryScope> {
  if (!snapshot) return getCopilotMemoryScope(sessionCopilotId)
  const { memoryCopilotId } = snapshot
  return Promise.resolve(
    memoryCopilotId
      ? { type: 'copilot', copilotId: memoryCopilotId, epoch: copilotMemoryEpoch(memoryCopilotId) }
      : { type: 'global' }
  )
}

/** Resolve the live memory scope before generation, including UI changes whose debounced persistence is still pending. */
export async function getCopilotMemoryScope(copilotId: string | undefined): Promise<MemoryScope> {
  if (!copilotId) return { type: 'global' }
  const owners = await memoryOwners.read()
  // Check ownership and capture the epoch in one synchronous step: a generation
  // reaches its memory tools several awaits later, and the scope has to pin the
  // incarnation it was actually resolved against.
  return owners.some((owner) => owner.id === copilotId)
    ? { type: 'copilot', copilotId, epoch: copilotMemoryEpoch(copilotId) }
    : { type: 'global' }
}
