import type { MemoryScope, SessionPromptContextSnapshot } from '@shared/types/agent-persona'
import { getDefaultStore } from 'jotai'
import { beforeEach, describe, expect, test, vi } from 'vitest'

const { copilotMemoryEpoch, getItem, persisted, retireCopilotMemories, setItem } = vi.hoisted(() => ({
  copilotMemoryEpoch: vi.fn(() => 0),
  getItem: vi.fn(),
  persisted: new Map<string, unknown>(),
  retireCopilotMemories: vi.fn().mockResolvedValue(undefined),
  setItem: vi.fn().mockResolvedValue(undefined),
}))

function readPersisted(key: string, initialValue: unknown) {
  return Promise.resolve(persisted.has(key) ? persisted.get(key) : initialValue)
}

vi.mock('@/storage', () => ({
  default: { getItem, setItem, removeItem: vi.fn().mockResolvedValue(undefined) },
  StorageKey: { MyCopilots: 'myCopilots' },
}))

vi.mock('./agentPersonaStore', () => ({ copilotMemoryEpoch, retireCopilotMemories }))

import {
  copilotMemoryOwnersAtom,
  disableCopilotMemory,
  enableCopilotMemory,
  getCopilotMemoryScope,
  getPausedCallMemoryScope,
  myCopilotsAtom,
  removeMyCopilot,
} from './copilotStore'

const copilot = { id: 'cp1', name: 'Tutor', prompt: 'p' }

describe('copilot store', () => {
  beforeEach(async () => {
    persisted.clear()
    persisted.set('myCopilots', [copilot])
    getItem.mockReset().mockImplementation(readPersisted)
    await getDefaultStore().set(myCopilotsAtom, [copilot])
    await getDefaultStore().set(copilotMemoryOwnersAtom, [])
    setItem.mockClear()
    retireCopilotMemories.mockClear()
    copilotMemoryEpoch.mockClear().mockReturnValue(0)
  })

  test('sessions without a copilot stay on the global store', async () => {
    await expect(getCopilotMemoryScope(undefined)).resolves.toEqual({ type: 'global' })
  })

  test('a copilot with its own memory owns the session memory scope', async () => {
    await enableCopilotMemory({ id: 'cp1', name: 'Tutor' })
    await expect(getCopilotMemoryScope('cp1')).resolves.toEqual({ type: 'copilot', copilotId: 'cp1', epoch: 0 })
  })

  test('a copilot that was never saved to My Copilots can own memory', async () => {
    await getDefaultStore().set(myCopilotsAtom, [])
    await enableCopilotMemory({ id: 'chatbox-featured:24', name: 'Translator' })
    await expect(getCopilotMemoryScope('chatbox-featured:24')).resolves.toEqual({
      type: 'copilot',
      copilotId: 'chatbox-featured:24',
      epoch: 0,
    })
  })

  test.each([
    ['the copilot keeps no memory of its own', async () => {}],
    [
      'its memory was switched back off',
      async () => {
        await enableCopilotMemory({ id: 'cp1', name: 'Tutor' })
        await disableCopilotMemory('cp1')
      },
    ],
  ])('falls back to the global store when %s', async (_label, arrange) => {
    await arrange()
    await expect(getCopilotMemoryScope('cp1')).resolves.toEqual({ type: 'global' })
  })

  test('uses the live atom value before debounced persistence catches up', async () => {
    let finishWrite: (() => void) | undefined
    setItem.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishWrite = resolve
        })
    )
    const update = enableCopilotMemory({ id: 'cp1', name: 'Tutor' })

    expect(persisted.get('copilot-memory-owners')).toBeUndefined()
    await expect(getCopilotMemoryScope('cp1')).resolves.toEqual({ type: 'copilot', copilotId: 'cp1', epoch: 0 })
    finishWrite?.()
    await update
  })

  test('waits for persisted ownership before initializing an editable draft', async () => {
    vi.resetModules()
    let finishRead: ((owners: unknown) => void) | undefined
    getItem.mockImplementation((key: string, initialValue: unknown) => {
      if (key !== 'copilot-memory-owners') return readPersisted(key, initialValue)
      return new Promise((resolve) => {
        finishRead = resolve
      })
    })
    const freshStore = await import('./copilotStore')

    let settled = false
    const enabled = freshStore.readCopilotMemoryEnabled('cp1').then((value) => {
      settled = true
      return value
    })
    await Promise.resolve()
    expect(settled).toBe(false)

    finishRead?.([{ id: 'cp1', name: 'Tutor' }])
    await expect(enabled).resolves.toBe(true)
  })

  test('pins the epoch the scope was resolved against, not the one at write time', async () => {
    await enableCopilotMemory({ id: 'cp1', name: 'Tutor' })
    copilotMemoryEpoch.mockReturnValue(2)
    const scope = await getCopilotMemoryScope('cp1')

    // Generation reaches its memory tools several awaits later; by then the copilot
    // may already have been deleted and the id handed to a new incarnation.
    copilotMemoryEpoch.mockReturnValue(3)
    expect(scope).toEqual({ type: 'copilot', copilotId: 'cp1', epoch: 2 })
  })

  const snapshotFor = (memoryCopilotId?: string): SessionPromptContextSnapshot => ({
    version: 1,
    soul: '',
    memories: [],
    workspaceInstructions: '',
    workspaceDirectories: [],
    capturedAt: 0,
    ...(memoryCopilotId ? { memoryCopilotId } : {}),
  })

  test.each([
    ['its memory is switched back off', async () => disableCopilotMemory('cp1')],
    ['the copilot is deleted outright', async () => removeMyCopilot('cp1')],
  ])('a paused call stays on the store its conversation was frozen against after %s', async (_label, arrange) => {
    await enableCopilotMemory({ id: 'cp1', name: 'Tutor' })
    await arrange()

    // Resolving live would hand the call the global store and leak what the
    // copilot decided to remember into the user's own memories.
    await expect(getPausedCallMemoryScope(snapshotFor('cp1'), 'cp1')).resolves.toMatchObject({
      type: 'copilot',
      copilotId: 'cp1',
    })
  })

  test('a paused call frozen against the global store ignores memory the copilot gained since', async () => {
    await enableCopilotMemory({ id: 'cp1', name: 'Tutor' })
    await expect(getPausedCallMemoryScope(snapshotFor(), 'cp1')).resolves.toEqual({ type: 'global' })
  })

  test('a paused call from a conversation that froze nothing falls back to the live scope', async () => {
    // A chat only snapshots once its store holds something, so a copilot saving its
    // very first memory has no frozen store to go back to.
    await enableCopilotMemory({ id: 'cp1', name: 'Tutor' })
    await expect(getPausedCallMemoryScope(undefined, 'cp1')).resolves.toMatchObject({
      type: 'copilot',
      copilotId: 'cp1',
    })
  })

  test('removal drops memory ownership before the bucket is retired', async () => {
    await enableCopilotMemory({ id: 'cp1', name: 'Tutor' })
    let scopeWhenCleared: MemoryScope | undefined
    retireCopilotMemories.mockImplementationOnce(async (id: string) => {
      scopeWhenCleared = await getCopilotMemoryScope(id)
    })

    await removeMyCopilot('cp1')

    expect(retireCopilotMemories).toHaveBeenCalledWith('cp1')
    expect(scopeWhenCleared).toEqual({ type: 'global' })
  })

  test('removal stops resolving copilot memory before list persistence settles', async () => {
    await enableCopilotMemory({ id: 'cp1', name: 'Tutor' })
    let finishCopilotWrite: (() => void) | undefined
    setItem.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishCopilotWrite = resolve
        })
    )

    const removal = removeMyCopilot('cp1')

    await expect(getCopilotMemoryScope('cp1')).resolves.toEqual({ type: 'global' })
    expect(retireCopilotMemories).not.toHaveBeenCalled()

    finishCopilotWrite?.()
    await removal
    expect(retireCopilotMemories).toHaveBeenCalledWith('cp1')
  })

  test('removal settles only once the memory bucket is retired, and surfaces its failure', async () => {
    let finishClear: (() => void) | undefined
    retireCopilotMemories.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishClear = resolve
        })
    )
    let settled = false
    const removal = removeMyCopilot('cp1').then(() => {
      settled = true
    })
    // Ownership is dropped first, so the retire is a few awaits into the removal.
    await vi.waitFor(() => {
      expect(retireCopilotMemories).toHaveBeenCalledWith('cp1')
    })
    expect(settled).toBe(false)
    finishClear?.()
    await removal
    expect(settled).toBe(true)

    retireCopilotMemories.mockRejectedValueOnce(new Error('storage down'))
    await expect(removeMyCopilot('cp1')).rejects.toThrow('storage down')
  })

  test('mutations queued during a slow hydration read all survive', async () => {
    vi.resetModules()
    let finishRead: ((copilots: unknown) => void) | undefined
    getItem.mockImplementation((key: string, initialValue: unknown) => {
      if (key !== 'myCopilots') return readPersisted(key, initialValue)
      return new Promise((resolve) => {
        finishRead = resolve
      })
    })
    const freshStore = await import('./copilotStore')

    const first = freshStore.addOrUpdateMyCopilot({ id: 'cp1', name: 'Tutor', prompt: 'p' })
    const second = freshStore.addOrUpdateMyCopilot({ id: 'cp2', name: 'Coach', prompt: 'q' })
    finishRead?.([])
    await Promise.all([first, second])

    const stored = await getDefaultStore().get(freshStore.myCopilotsAtom)
    expect(stored.map((item) => item.id).sort()).toEqual(['cp1', 'cp2'])
  })
})
