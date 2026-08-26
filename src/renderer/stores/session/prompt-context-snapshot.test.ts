import type { Message, SessionPromptContextSnapshot, SessionSettings } from '@shared/types'
import { COPILOT_PROMPT_MAX_CHARS } from '@shared/types/agent-persona'
import { beforeEach, describe, expect, test, vi } from 'vitest'

const { captureSnapshot, listMemoriesForScope, matchesDirectories } = vi.hoisted(() => ({
  captureSnapshot: vi.fn(),
  listMemoriesForScope: vi.fn(),
  matchesDirectories: vi.fn(),
}))

vi.mock('@/stores/agentPersonaStore', () => ({
  captureSessionPromptContextSnapshot: captureSnapshot,
  listMemoriesForScope,
  sessionPromptContextSnapshotMatchesDirectories: matchesDirectories,
}))

import { extractCopilotPersona, resolveSessionPromptContextSnapshot } from './prompt-context-snapshot'

function snapshot(
  agentToolContractVersion: 1 | 2,
  extra: Partial<SessionPromptContextSnapshot> = {}
): SessionPromptContextSnapshot {
  return {
    version: 1,
    soul: '',
    memories: [],
    workspaceInstructions: '',
    workspaceDirectories: [],
    capturedAt: 1,
    scope: 'agent',
    agentToolContractVersion,
    ...extra,
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

const assistantMessage = {
  id: 'assistant-1',
  role: 'assistant',
  timestamp: 1,
  contentParts: [{ type: 'text', text: 'done' }],
} as Message

describe('resolveSessionPromptContextSnapshot', () => {
  beforeEach(() => {
    captureSnapshot.mockReset()
    listMemoriesForScope.mockReset()
    listMemoriesForScope.mockResolvedValue([])
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

  test('agent mode reuses a snapshot whose memory scope still matches', async () => {
    matchesDirectories.mockReturnValue(true)
    const existing = snapshot(2, { memoryCopilotId: 'cp1' })

    const result = await resolveSessionPromptContextSnapshot({
      effectiveAgentMode: 'on',
      memoryEnabled: true,
      memoryScope: { type: 'copilot', copilotId: 'cp1', epoch: 0 },
      settings: { sessionPromptContextSnapshot: existing } as SessionSettings,
      messages: [],
      targetMsgIx: 0,
    })

    expect(result).toBe(existing)
    expect(captureSnapshot).not.toHaveBeenCalled()
  })

  test('agent mode re-captures when the memory scope changed', async () => {
    matchesDirectories.mockReturnValue(true)
    captureSnapshot.mockResolvedValue(snapshot(2, { memoryCopilotId: 'cp1' }))
    const persist = vi.fn()

    const result = await resolveSessionPromptContextSnapshot({
      effectiveAgentMode: 'on',
      memoryEnabled: true,
      memoryScope: { type: 'copilot', copilotId: 'cp1', epoch: 0 },
      settings: { sessionPromptContextSnapshot: snapshot(2) } as SessionSettings,
      messages: [],
      targetMsgIx: 0,
      persist,
    })

    expect(captureSnapshot).toHaveBeenCalledWith(undefined, 'agent', { type: 'copilot', copilotId: 'cp1', epoch: 0 })
    expect(result?.memoryCopilotId).toBe('cp1')
    expect(persist).toHaveBeenCalledTimes(1)
  })

  test('chat mode reuses a snapshot only when the memory scope matches', async () => {
    const existing = snapshot(2, { scope: 'chat', memoryCopilotId: 'cp1' })
    const settings = { sessionPromptContextSnapshot: existing } as SessionSettings

    await expect(
      resolveSessionPromptContextSnapshot({
        effectiveAgentMode: 'off',
        memoryEnabled: true,
        memoryScope: { type: 'copilot', copilotId: 'cp1', epoch: 0 },
        settings,
        messages: [assistantMessage],
        targetMsgIx: 1,
      })
    ).resolves.toBe(existing)

    // Mid-conversation scope change: the other store's memories stop being
    // injected, the rest of the frozen snapshot still anchors the prompt prefix,
    // and nothing new is captured until the next conversation start.
    const persist = vi.fn()
    const { memoryCopilotId: _dropped, ...withoutCopilot } = existing
    await expect(
      resolveSessionPromptContextSnapshot({
        effectiveAgentMode: 'off',
        memoryEnabled: true,
        memoryScope: { type: 'global' },
        settings,
        messages: [assistantMessage],
        targetMsgIx: 1,
        persist,
      })
    ).resolves.toEqual({ ...withoutCopilot, memories: [] })
    expect(captureSnapshot).not.toHaveBeenCalled()
    // The store this generation's tools were built for is recorded, so a tool call
    // it pauses is continued against that store rather than the outgoing one.
    expect(persist).toHaveBeenCalledWith({ ...withoutCopilot, memories: [] })
  })

  test('chat mode records the copilot store a mid-conversation switch moves to', async () => {
    const existing = snapshot(2, { scope: 'chat' })
    const persist = vi.fn()

    await expect(
      resolveSessionPromptContextSnapshot({
        effectiveAgentMode: 'off',
        memoryEnabled: true,
        memoryScope: { type: 'copilot', copilotId: 'cp1', epoch: 0 },
        settings: { sessionPromptContextSnapshot: existing } as SessionSettings,
        messages: [assistantMessage],
        targetMsgIx: 1,
        persist,
      })
    ).resolves.toEqual({ ...existing, memories: [], memoryCopilotId: 'cp1' })
    expect(persist).toHaveBeenCalledWith({ ...existing, memories: [], memoryCopilotId: 'cp1' })
  })

  test('chat mode re-captures at the next conversation start after a scope change', async () => {
    listMemoriesForScope.mockResolvedValue([{ id: 'gm1', content: 'global fact', createdAt: 1 }])
    captureSnapshot.mockResolvedValue(snapshot(2, { scope: 'chat' }))
    const persist = vi.fn()

    const result = await resolveSessionPromptContextSnapshot({
      effectiveAgentMode: 'off',
      memoryEnabled: true,
      memoryScope: { type: 'global' },
      settings: {
        sessionPromptContextSnapshot: snapshot(2, { scope: 'chat', memoryCopilotId: 'cp1' }),
      } as SessionSettings,
      messages: [],
      targetMsgIx: 0,
      persist,
    })

    expect(captureSnapshot).toHaveBeenCalledWith(undefined, 'chat', { type: 'global' })
    expect(result?.memoryCopilotId).toBeUndefined()
    expect(persist).toHaveBeenCalledTimes(1)
  })

  test('chat mode captures from the copilot store at conversation start', async () => {
    listMemoriesForScope.mockResolvedValue([{ id: 'cm1', content: 'copilot fact', createdAt: 1 }])
    captureSnapshot.mockResolvedValue(snapshot(2, { scope: 'chat', memoryCopilotId: 'cp1' }))
    const persist = vi.fn()

    const result = await resolveSessionPromptContextSnapshot({
      effectiveAgentMode: 'off',
      memoryEnabled: true,
      memoryScope: { type: 'copilot', copilotId: 'cp1', epoch: 0 },
      settings: {} as SessionSettings,
      messages: [],
      targetMsgIx: 0,
      persist,
    })

    expect(listMemoriesForScope).toHaveBeenCalledWith({ type: 'copilot', copilotId: 'cp1', epoch: 0 })
    expect(captureSnapshot).toHaveBeenCalledWith(undefined, 'chat', { type: 'copilot', copilotId: 'cp1', epoch: 0 })
    expect(result?.memoryCopilotId).toBe('cp1')
    expect(persist).toHaveBeenCalledTimes(1)
  })
})
