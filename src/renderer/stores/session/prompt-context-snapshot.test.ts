import type { Message, SessionPromptContextSnapshot } from '@shared/types'
import { COPILOT_PROMPT_MAX_CHARS } from '@shared/types/agent-persona'
import { beforeEach, describe, expect, test, vi } from 'vitest'

const captureSnapshot = vi.hoisted(() => vi.fn())
const matchesDirectories = vi.hoisted(() => vi.fn().mockReturnValue(false))

vi.mock('@/stores/agentPersonaStore', () => ({
  captureSessionPromptContextSnapshot: captureSnapshot,
  listMemories: vi.fn().mockResolvedValue([]),
  sessionPromptContextSnapshotMatchesDirectories: matchesDirectories,
}))

import { extractCopilotPersona, resolveSessionPromptContextSnapshot } from './prompt-context-snapshot'

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

function systemMessage(text: string): Message {
  return {
    id: 'sys-1',
    role: 'system',
    contentParts: [{ type: 'text', text }],
  } as Message
}

describe('extractCopilotPersona', () => {
  test('reads the first system message before the target index', () => {
    expect(extractCopilotPersona([systemMessage('You are a pirate copilot.')], 1)).toBe('You are a pirate copilot.')
  })

  test('returns undefined when there is no system message', () => {
    expect(extractCopilotPersona([], 0)).toBeUndefined()
  })

  test('caps an oversized Copilot prompt to the Copilot budget', () => {
    const overlay = `pirate ${'x'.repeat(COPILOT_PROMPT_MAX_CHARS + 200)}`
    const bounded = extractCopilotPersona([systemMessage(overlay)], 1)
    expect(bounded).toContain('[Copilot truncated for context safety]')
    expect(bounded?.length).toBeLessThan(overlay.length)
  })
})

describe('resolveSessionPromptContextSnapshot', () => {
  beforeEach(() => {
    captureSnapshot.mockReset()
    matchesDirectories.mockReset()
    matchesDirectories.mockReturnValue(false)
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

  test('freezes the Copilot prompt into a new agent snapshot', async () => {
    captureSnapshot.mockResolvedValue(snapshot(2))

    const result = await resolveSessionPromptContextSnapshot({
      effectiveAgentMode: 'on',
      memoryEnabled: true,
      settings: {},
      messages: [systemMessage('You are a pirate copilot.')],
      targetMsgIx: 1,
      copilotId: 'copilot-1',
    })

    expect(result?.copilotPersona).toBe('You are a pirate copilot.')
  })

  test('persists a bounded Copilot overlay in the snapshot', async () => {
    captureSnapshot.mockResolvedValue(snapshot(2))
    const overlay = `pirate ${'x'.repeat(COPILOT_PROMPT_MAX_CHARS + 200)}`

    const result = await resolveSessionPromptContextSnapshot({
      effectiveAgentMode: 'on',
      memoryEnabled: true,
      settings: {},
      messages: [systemMessage(overlay)],
      targetMsgIx: 1,
      copilotId: 'copilot-1',
    })

    expect(result?.copilotPersona).toContain('[Copilot truncated for context safety]')
    expect(result?.copilotPersona?.length).toBeLessThan(overlay.length)
  })

  test('does not freeze a session system prompt without a Copilot', async () => {
    captureSnapshot.mockResolvedValue(snapshot(2))

    const result = await resolveSessionPromptContextSnapshot({
      effectiveAgentMode: 'on',
      memoryEnabled: true,
      settings: {},
      messages: [systemMessage('You are a helpful assistant.')],
      targetMsgIx: 1,
    })

    expect(result?.copilotPersona).toBeUndefined()
  })

  test('reuses a frozen Copilot overlay without re-reading messages', async () => {
    matchesDirectories.mockReturnValue(true)
    const existing = { ...snapshot(2), copilotPersona: 'Frozen pirate overlay.' }

    const result = await resolveSessionPromptContextSnapshot({
      effectiveAgentMode: 'on',
      memoryEnabled: true,
      settings: { sessionPromptContextSnapshot: existing },
      messages: [systemMessage('Live prompt that must not replace the snapshot.')],
      targetMsgIx: 1,
      copilotId: 'copilot-1',
    })

    expect(captureSnapshot).not.toHaveBeenCalled()
    expect(result?.copilotPersona).toBe('Frozen pirate overlay.')
  })
})
