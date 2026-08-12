import { GenerationRequestSnapshotSchema, type Message } from '@shared/types'
import { jsonSchema, type ModelMessage, type ToolSet } from 'ai'
import { describe, expect, it } from 'vitest'
import { createGenerationRequestSnapshot } from './request-snapshot'

const promptMessages: Message[] = [
  {
    id: 'user-1',
    role: 'user',
    contentParts: [{ type: 'text', text: 'Inspect the repository' }],
  },
]

const modelMessages: ModelMessage[] = [{ role: 'user', content: 'Inspect the repository' }]

describe('createGenerationRequestSnapshot', () => {
  it('captures a versioned canonical request envelope', async () => {
    const storedDefinitions = new Map<string, string>()
    const tools: ToolSet = {
      inspect: {
        description: 'Inspect one path',
        inputSchema: jsonSchema({
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path'],
          additionalProperties: false,
        }),
        strict: true,
      },
    }

    const snapshot = await createGenerationRequestSnapshot({
      capturedAt: 1_000,
      provider: 'openai',
      modelId: 'test-model',
      apiStyle: 'openai',
      agentMode: true,
      callSettings: {
        temperature: 0.2,
        maxOutputTokens: 4_096,
        providerOptions: { anthropic: { thinking: { type: 'enabled', budgetTokens: 1_024 } } },
      },
      stream: true,
      promptMessages,
      modelMessages,
      systemPrompt: 'You are a coding agent.',
      tools,
      storeDefinitions: (storageKey, value) => {
        storedDefinitions.set(storageKey, value)
        return Promise.resolve()
      },
    })

    expect(GenerationRequestSnapshotSchema.parse(snapshot)).toEqual(snapshot)
    expect(snapshot).toMatchObject({
      version: 1,
      capturedAt: 1_000,
      model: { provider: 'openai', id: 'test-model', apiStyle: 'openai' },
      agentMode: true,
      providerOptions: { anthropic: { thinking: { type: 'enabled', budgetTokens: 1_024 } } },
      callSettings: { temperature: 0.2, maxOutputTokens: 4_096, stream: true },
      context: {
        sessionBoundary: { messageCount: 1, firstMessageId: 'user-1', lastMessageId: 'user-1' },
        modelMessageCount: 1,
      },
      definitions: {
        storageKey: expect.stringMatching(/^generation-request:[a-f0-9]{64}$/),
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    })
    expect(JSON.parse(storedDefinitions.get(snapshot.definitions.storageKey) ?? '')).toMatchObject({
      version: 1,
      systemPrompt: 'You are a coding agent.',
      tools: [
        {
          type: 'function',
          name: 'inspect',
          description: 'Inspect one path',
          strict: true,
        },
      ],
    })
    expect(snapshot.context.sha256).toMatch(/^[a-f0-9]{64}$/)
  })

  it('changes the context fingerprint when model-visible messages change', async () => {
    const base = {
      capturedAt: 1_000,
      modelId: 'test-model',
      agentMode: false,
      callSettings: {},
      stream: true,
      promptMessages,
      tools: {},
      storeDefinitions: () => Promise.resolve(),
    } as const

    const first = await createGenerationRequestSnapshot({ ...base, modelMessages })
    const second = await createGenerationRequestSnapshot({
      ...base,
      modelMessages: [{ role: 'user', content: 'Different request' }],
    })

    expect(first.context.sha256).not.toBe(second.context.sha256)
  })
})
