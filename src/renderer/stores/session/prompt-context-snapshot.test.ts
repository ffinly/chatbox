import type { SessionPromptContextSnapshot } from '@shared/types'
import { beforeEach, describe, expect, test, vi } from 'vitest'

const captureSnapshot = vi.hoisted(() => vi.fn())

vi.mock('@/stores/agentPersonaStore', () => ({
  captureSessionPromptContextSnapshot: captureSnapshot,
  listMemories: vi.fn().mockResolvedValue([]),
  sessionPromptContextSnapshotMatchesDirectories: vi.fn().mockReturnValue(false),
}))

import { resolveSessionPromptContextSnapshot } from './prompt-context-snapshot'

function snapshot(agentToolContractVersion: 1 | 2): SessionPromptContextSnapshot {
  return {
    version: 1,
    soul: '',
    memories: [],
    workspaceInstructions: '',
    workspaceDirectories: [],
    capturedAt: 1,
    scope: 'agent',
    agentToolContractVersion,
  }
}

describe('resolveSessionPromptContextSnapshot', () => {
  beforeEach(() => {
    captureSnapshot.mockReset()
  })

  test.each([
    [2, 1],
    [1, 2],
  ] as const)('keeps frozen command contract %i when recapturing on contract %i', async (frozen, current) => {
    captureSnapshot.mockResolvedValue(snapshot(current))

    const result = await resolveSessionPromptContextSnapshot({
      effectiveAgentMode: 'on',
      memoryEnabled: true,
      settings: {
        workingDirectories: ['/new-workdir'],
        sessionPromptContextSnapshot: snapshot(frozen),
      },
      messages: [],
      targetMsgIx: 0,
    })

    expect(result?.agentToolContractVersion).toBe(frozen)
  })
})
