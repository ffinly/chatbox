import { beforeEach, describe, expect, test, vi } from 'vitest'

const { platformName, storageValues } = vi.hoisted(() => ({
  platformName: { current: 'darwin' },
  storageValues: new Map<string, unknown>(),
}))

vi.mock('@/platform', () => ({
  default: { getPlatform: vi.fn(() => Promise.resolve(platformName.current)) },
}))

vi.mock('@/storage', () => ({
  default: {
    getItem: vi.fn((key: string, initialValue: unknown) => {
      if (!storageValues.has(key)) storageValues.set(key, initialValue)
      return Promise.resolve(storageValues.get(key))
    }),
    setItemNow: vi.fn((key: string, value: unknown) => {
      storageValues.set(key, value)
      return Promise.resolve()
    }),
  },
}))

vi.mock('i18next', () => ({ t: (key: string) => key }))

vi.mock('@/packages/model-calls/workspace-instructions', () => ({
  buildWorkspaceInstructions: vi.fn().mockResolvedValue(''),
  normalizeWorkspaceDirectory: (dir: string) => dir,
}))

import {
  AGENT_MEMORIES_STORAGE_KEY,
  addMemory,
  captureSessionPromptContextSnapshot,
  deleteMemory,
  importMemories,
  listMemories,
  readSoul,
  updateSoul,
  writeSoul,
} from './agentPersonaStore'

beforeEach(() => {
  storageValues.clear()
  platformName.current = 'darwin'
})

describe('agent tool contract snapshot', () => {
  test.each(['darwin', 'linux', 'win32'])('freezes v2 on the %s desktop command backend', async (name) => {
    platformName.current = name
    await expect(captureSessionPromptContextSnapshot([], 'agent')).resolves.toMatchObject({
      agentToolContractVersion: 2,
    })
  })

  test.each(['web', 'ios', 'android', 'harmony'])('freezes the legacy fallback contract on %s', async (name) => {
    platformName.current = name
    await expect(captureSessionPromptContextSnapshot([], 'agent')).resolves.toMatchObject({
      agentToolContractVersion: 1,
    })
  })
})

describe('memory mutation serialization', () => {
  test('parallel save_memory calls keep every entry', async () => {
    const results = await Promise.all([addMemory('fact one'), addMemory('fact two'), addMemory('fact three')])
    expect(results.every((result) => result.ok)).toBe(true)
    const memories = await listMemories()
    expect(memories.map((entry) => entry.content).sort()).toEqual(['fact one', 'fact three', 'fact two'])
  })

  test('a deletion overlapping an add loses neither operation', async () => {
    const added = await addMemory('existing fact')
    if (!added.ok) throw new Error('setup failed')
    const [deleted, addedSecond] = await Promise.all([deleteMemory(added.entry.id), addMemory('new fact')])
    expect(deleted).toBe(true)
    expect(addedSecond.ok).toBe(true)
    const memories = await listMemories()
    expect(memories.map((entry) => entry.content)).toEqual(['new fact'])
  })

  test('duplicate contents are rejected even when submitted in parallel', async () => {
    const results = await Promise.all([addMemory('same fact'), addMemory('same fact')])
    expect(results.filter((result) => result.ok)).toHaveLength(1)
    expect(await listMemories()).toHaveLength(1)
  })

  test('corrupt stored data falls back to an empty list', async () => {
    storageValues.set(AGENT_MEMORIES_STORAGE_KEY, { not: 'an array' })
    expect(await listMemories()).toEqual([])
  })

  test('bulk import appends unique valid entries without exceeding limits', async () => {
    await addMemory('existing fact')
    const result = await importMemories([
      'new fact',
      'existing fact',
      '',
      'x'.repeat(1_001),
      'another fact',
      'new fact',
    ])

    expect(result).toEqual({
      imported: 2,
      skippedDuplicate: 2,
      skippedEmpty: 1,
      skippedTooLong: 1,
      skippedLimit: 0,
    })
    expect((await listMemories()).map((entry) => entry.content)).toEqual(['existing fact', 'new fact', 'another fact'])
  })
})

describe('soul mutation serialization', () => {
  test('updateSoul applies edits atomically against the latest content', async () => {
    await writeSoul('alpha beta')
    const [first, second] = await Promise.all([
      updateSoul((content) => content.replace('alpha', 'gamma')),
      updateSoul((content) => content.replace('beta', 'delta')),
    ])
    expect('record' in first).toBe(true)
    expect('record' in second).toBe(true)
    expect((await readSoul()).content).toBe('gamma delta')
  })

  test('updateSoul surfaces updater errors without writing', async () => {
    await writeSoul('stable content')
    const result = await updateSoul(() => ({ error: 'search text not found' }))
    expect(result).toEqual({ error: 'search text not found' })
    expect((await readSoul()).content).toBe('stable content')
  })
})
