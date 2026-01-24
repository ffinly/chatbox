import { ModelProviderEnum, ModelProviderType } from '../../types'
import { defineProvider } from '../registry'
import MistralAI from './models/mistral-ai'

export const mistralAIProvider = defineProvider({
  id: ModelProviderEnum.MistralAI,
  name: 'Mistral AI',
  type: ModelProviderType.OpenAI,
  urls: {
    website: 'https://mistral.ai',
  },
  defaultSettings: {
    apiHost: 'https://api.mistral.ai/v1',
    models: [
      {
        modelId: 'pixtral-large-latest',
        contextWindow: 128_000,
        capabilities: ['vision', 'tool_use'],
      },
      {
        modelId: 'mistral-large-latest',
        contextWindow: 32_000,
        capabilities: ['tool_use'],
      },
      {
        modelId: 'mistral-medium-latest',
        contextWindow: 32_000,
        capabilities: ['tool_use'],
      },
      {
        modelId: 'mistral-small-latest',
        contextWindow: 32_000,
        capabilities: ['tool_use'],
      },
      {
        modelId: 'magistral-medium-latest',
        contextWindow: 32_000,
        capabilities: ['reasoning', 'tool_use'],
      },
      {
        modelId: 'magistral-small-latest',
        contextWindow: 32_000,
        capabilities: ['reasoning', 'tool_use'],
      },
      {
        modelId: 'codestral-latest',
        contextWindow: 32_000,
        capabilities: [],
      },
      {
        modelId: 'mistral-embed',
        type: 'embedding',
      },
    ],
  },
  createModel: (config) => {
    return new MistralAI(
      {
        apiKey: config.providerSetting.apiKey || '',
        model: config.model,
        temperature: config.settings.temperature,
        topP: config.settings.topP,
        maxOutputTokens: config.settings.maxTokens,
        stream: config.settings.stream,
      },
      config.dependencies
    )
  },
  getDisplayName: (modelId, providerSettings) => {
    return `MistralAI (${providerSettings?.models?.find((m) => m.modelId === modelId)?.nickname || modelId})`
  },
})
