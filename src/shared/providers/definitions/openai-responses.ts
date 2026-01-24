import { ModelProviderEnum, ModelProviderType } from '../../types'
import { defineProvider } from '../registry'
import OpenAIResponses from './models/openai-responses'

export const openaiResponsesProvider = defineProvider({
  id: ModelProviderEnum.OpenAIResponses,
  name: 'OpenAI (Responses)',
  type: ModelProviderType.OpenAIResponses,
  description: 'openai-responses',
  urls: {
    website: 'https://openai.com',
    docs: 'https://platform.openai.com/docs/api-reference/responses',
  },
  defaultSettings: {
    apiHost: 'https://api.openai.com',
    apiPath: '/responses',
    // Responses API supported models - https://platform.openai.com/docs/api-reference/responses
    models: [
      {
        modelId: 'gpt-5.1',
        capabilities: ['vision', 'tool_use'],
        contextWindow: 400_000,
        maxOutput: 128_000,
      },
      {
        modelId: 'gpt-5',
        capabilities: ['vision', 'tool_use'],
        contextWindow: 400_000,
        maxOutput: 128_000,
      },
      {
        modelId: 'gpt-5-mini',
        capabilities: ['vision', 'tool_use'],
        contextWindow: 400_000,
        maxOutput: 128_000,
      },
      {
        modelId: 'gpt-5-pro',
        capabilities: ['vision', 'tool_use'],
        contextWindow: 400_000,
        maxOutput: 272_000,
      },
      {
        modelId: 'o3-pro',
        capabilities: ['vision', 'reasoning', 'tool_use'],
        contextWindow: 200_000,
        maxOutput: 100_000,
      },
    ],
  },
  createModel: (config) => {
    return new OpenAIResponses(
      {
        apiKey: config.providerSetting.apiKey || '',
        apiHost: config.formattedApiHost,
        apiPath:
          config.providerSetting.apiPath ||
          config.globalSettings.providers?.[config.settings.provider!]?.apiPath ||
          '/responses',
        model: config.model,
        temperature: config.settings.temperature,
        topP: config.settings.topP,
        maxOutputTokens: config.settings.maxTokens,
        stream: config.settings.stream,
        useProxy: config.providerSetting.useProxy,
      },
      config.dependencies
    )
  },
  getDisplayName: (modelId, providerSettings) => {
    return `OpenAI Responses API (${providerSettings?.models?.find((m) => m.modelId === modelId)?.nickname || modelId})`
  },
})
