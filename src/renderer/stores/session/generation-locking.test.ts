import type { Message, Session } from '@shared/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  getSessionMock,
  getSessionSettingsMock,
  createInactiveForkMock,
  createNewForkMock,
  findMessageLocationMock,
  insertMessageAfterMock,
  orchestrateGenerationMock,
  guardSessionActionMock,
} = vi.hoisted(() => ({
  getSessionMock: vi.fn(),
  getSessionSettingsMock: vi.fn(),
  createInactiveForkMock: vi.fn(),
  createNewForkMock: vi.fn(),
  findMessageLocationMock: vi.fn(),
  insertMessageAfterMock: vi.fn(),
  orchestrateGenerationMock: vi.fn(),
  guardSessionActionMock: vi.fn(),
}))

vi.mock('../chatStore', () => ({
  getSession: getSessionMock,
  getSessionSettings: getSessionSettingsMock,
}))
vi.mock('./attachment-resolver', () => ({ createAttachmentResolver: vi.fn() }))
vi.mock('./forks', () => ({
  createInactiveFork: createInactiveForkMock,
  createNewFork: createNewForkMock,
  findMessageLocation: findMessageLocationMock,
}))
vi.mock('./messages', () => ({ insertMessageAfter: insertMessageAfterMock }))
vi.mock('./orchestration', () => ({ orchestrateGeneration: orchestrateGenerationMock }))
vi.mock('./action-guard', () => ({ guardSessionAction: guardSessionActionMock }))
vi.mock('./utils', () => ({ getSessionWebBrowsing: vi.fn() }))

import { generate, generateMore, generateMoreInNewFork, regenerateInNewFork } from './generation'
import { resetSessionGenerationLocksForTests } from './generation-lock'

function message(id: string): Message {
  return { id, role: 'assistant', contentParts: [], generating: true }
}

describe('generation entry-point locking', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetSessionGenerationLocksForTests()
    getSessionMock.mockResolvedValue({ id: 'session-1', name: 'Session', messages: [] })
    getSessionSettingsMock.mockResolvedValue({})
    guardSessionActionMock.mockResolvedValue(true)
    createInactiveForkMock.mockImplementation(async (_sessionId, _msgId, branchMessages: Message[]) => [
      { id: 'user-1', role: 'user', contentParts: [] },
      ...branchMessages,
    ])
    insertMessageAfterMock.mockResolvedValue(undefined)
  })

  afterEach(() => {
    resetSessionGenerationLocksForTests()
  })

  it('serializes public generation calls for the same session', async () => {
    let finishFirst = () => {}
    const firstGeneration = new Promise<void>((resolve) => {
      finishFirst = resolve
    })
    orchestrateGenerationMock.mockReturnValueOnce(firstGeneration).mockResolvedValueOnce(undefined)

    const first = generate('session-1', message('assistant-1'))
    const second = generate('session-1', message('assistant-2'))

    await vi.waitFor(() => expect(orchestrateGenerationMock).toHaveBeenCalledOnce())
    finishFirst()
    await Promise.all([first, second])

    expect(orchestrateGenerationMock.mock.calls.map((call) => call[1].id)).toEqual(['assistant-1', 'assistant-2'])
  })

  it('starts multiple alternative replies for the same message concurrently', async () => {
    let finishFirst = () => {}
    const firstGeneration = new Promise<void>((resolve) => {
      finishFirst = resolve
    })
    orchestrateGenerationMock.mockReturnValueOnce(firstGeneration).mockResolvedValueOnce(undefined)

    const first = generateMore('session-1', 'user-1')
    await vi.waitFor(() => expect(orchestrateGenerationMock).toHaveBeenCalledOnce())

    const second = generateMore('session-1', 'user-1')
    await vi.waitFor(() => expect(orchestrateGenerationMock).toHaveBeenCalledTimes(2))

    expect(createInactiveForkMock).toHaveBeenCalledTimes(2)
    expect(createInactiveForkMock.mock.calls.map((call) => call[1])).toEqual(['user-1', 'user-1'])
    expect(insertMessageAfterMock).not.toHaveBeenCalled()
    expect(orchestrateGenerationMock.mock.calls.every((call) => call[2].contextMessages.length === 2)).toBe(true)

    finishFirst()
    await Promise.all([first, second])
  })

  it('inserts the first reply normally when the prompt has no active answer yet', async () => {
    createInactiveForkMock.mockResolvedValueOnce(null)

    await generateMore('session-1', 'user-1')

    expect(insertMessageAfterMock).toHaveBeenCalledOnce()
    expect(insertMessageAfterMock).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({ role: 'assistant' }),
      'user-1'
    )
    expect(orchestrateGenerationMock).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({ role: 'assistant' }),
      { operationType: 'regenerate' }
    )
  })

  it('keeps legacy picture sessions read-only across generation entry points', async () => {
    const pictureSession: Session = {
      id: 'session-1',
      name: 'Picture Session',
      type: 'picture',
      messages: [],
    }
    getSessionMock.mockResolvedValue(pictureSession)

    await Promise.all([
      generate('session-1', message('assistant-1')),
      generateMore('session-1', 'user-1'),
      generateMoreInNewFork('session-1', 'user-1'),
      regenerateInNewFork('session-1', message('assistant-1')),
    ])

    expect(orchestrateGenerationMock).not.toHaveBeenCalled()
    expect(createInactiveForkMock).not.toHaveBeenCalled()
    expect(createNewForkMock).not.toHaveBeenCalled()
    expect(findMessageLocationMock).not.toHaveBeenCalled()
    expect(insertMessageAfterMock).not.toHaveBeenCalled()
  })
})
