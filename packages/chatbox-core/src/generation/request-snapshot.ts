import { asSchema, type ModelMessage, type ToolSet } from 'ai'
import type { CallSettings } from '../models/types'
import type { GenerationRequestDefinitions, GenerationRequestSnapshot, GenerationRequestTool, Message } from '../types'

type SnapshotJson = Extract<GenerationRequestTool, { type: 'provider' }>['args']
type SnapshotProviderMetadata = NonNullable<Extract<GenerationRequestTool, { type: 'function' }>['providerOptions']>

function cloneJson(value: unknown): SnapshotJson {
  const serialized = JSON.stringify(value)
  if (serialized === undefined) {
    throw new Error('Generation request snapshot contains a non-serializable JSON value')
  }
  return JSON.parse(serialized) as SnapshotJson
}

async function sha256Text(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value)
  const subtle = (
    globalThis as typeof globalThis & {
      crypto?: { subtle?: { digest(algorithm: string, data: Uint8Array): Promise<ArrayBuffer> } }
    }
  ).crypto?.subtle
  if (!subtle) {
    throw new Error('Generation request snapshots require Web Crypto SHA-256 support')
  }
  const digest = await subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function fingerprintMessages(messages: ModelMessage[]): Promise<string> {
  return sha256Text(JSON.stringify(messages))
}

function snapshotTools(tools: ToolSet): Promise<GenerationRequestTool[]> {
  return Promise.all(
    Object.entries(tools)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(async ([name, tool]): Promise<GenerationRequestTool> => {
        if (tool.type === 'provider') {
          return {
            type: 'provider',
            name,
            id: tool.id,
            args: cloneJson(tool.args),
          }
        }

        const inputSchema = cloneJson(await asSchema(tool.inputSchema).jsonSchema)
        return {
          type: 'function',
          name,
          ...(tool.description === undefined ? {} : { description: tool.description }),
          inputSchema,
          ...(tool.inputExamples === undefined
            ? {}
            : { inputExamples: tool.inputExamples.map(({ input }) => ({ input: cloneJson(input) })) }),
          ...(tool.providerOptions === undefined
            ? {}
            : { providerOptions: cloneJson(tool.providerOptions) as SnapshotProviderMetadata }),
          ...(tool.strict === undefined ? {} : { strict: tool.strict }),
        }
      })
  )
}

export interface CreateGenerationRequestSnapshotOptions {
  capturedAt: number
  provider?: string
  modelId: string
  apiStyle?: string
  agentMode: boolean
  callSettings: CallSettings
  stream: boolean
  promptMessages: Message[]
  appendedMessageIds?: readonly string[]
  modelMessages: ModelMessage[]
  systemPrompt?: string
  tools: ToolSet
  storeDefinitions: (storageKey: string, value: string) => Promise<void>
}

/** Build the durable request header written immediately before model-stream dispatch. */
export async function createGenerationRequestSnapshot(
  options: CreateGenerationRequestSnapshotOptions
): Promise<GenerationRequestSnapshot> {
  const firstPromptMessage = options.promptMessages[0]
  const lastPromptMessage = options.promptMessages.at(-1)
  const definitions: GenerationRequestDefinitions = {
    version: 1,
    ...(options.systemPrompt === undefined || options.systemPrompt.length === 0
      ? {}
      : { systemPrompt: options.systemPrompt }),
    tools: await snapshotTools(options.tools),
  }
  const serializedDefinitions = JSON.stringify(definitions)
  const definitionsSha256 = await sha256Text(serializedDefinitions)
  const definitionsStorageKey = `generation-request:${definitionsSha256}`
  await options.storeDefinitions(definitionsStorageKey, serializedDefinitions)

  return {
    version: 1,
    capturedAt: options.capturedAt,
    model: {
      ...(options.provider === undefined ? {} : { provider: options.provider }),
      id: options.modelId,
      ...(options.apiStyle === undefined ? {} : { apiStyle: options.apiStyle }),
    },
    agentMode: options.agentMode,
    ...(options.callSettings.providerOptions === undefined
      ? {}
      : { providerOptions: cloneJson(options.callSettings.providerOptions) as SnapshotProviderMetadata }),
    callSettings: {
      ...(options.callSettings.temperature === undefined ? {} : { temperature: options.callSettings.temperature }),
      ...(options.callSettings.topP === undefined ? {} : { topP: options.callSettings.topP }),
      ...(options.callSettings.maxOutputTokens === undefined
        ? {}
        : { maxOutputTokens: options.callSettings.maxOutputTokens }),
      stream: options.stream,
      ...(options.callSettings.system === undefined ? {} : { system: options.callSettings.system }),
    },
    context: {
      sessionBoundary: {
        messageCount: options.promptMessages.length,
        ...(firstPromptMessage === undefined ? {} : { firstMessageId: firstPromptMessage.id }),
        ...(lastPromptMessage === undefined ? {} : { lastMessageId: lastPromptMessage.id }),
      },
      ...(options.appendedMessageIds === undefined || options.appendedMessageIds.length === 0
        ? {}
        : { appendedMessageIds: [...options.appendedMessageIds] }),
      modelMessageCount: options.modelMessages.length,
      sha256: await fingerprintMessages(options.modelMessages),
    },
    definitions: {
      storageKey: definitionsStorageKey,
      sha256: definitionsSha256,
    },
  }
}
