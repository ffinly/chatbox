import { ModelProviderEnum, ModelProviderType } from '../../types'
import { defineProvider } from '../registry'
import OpenAI from './models/openai'

export const openaiProvider = defineProvider({
  id: ModelProviderEnum.OpenAI,
  name: 'OpenAI',
  type: ModelProviderType.OpenAI,
  description: 'openai',
  urls: {
    website: 'https://openai.com',
  },
  defaultSettings: {
    apiHost: 'https://api.openai.com',
    // https://platform.openai.com/docs/models
    models: [
      {
        modelId: 'gpt-5.1',
        capabilities: ['vision', 'tool_use'],
        contextWindow: 400_000,
        maxOutput: 128_000,
      },
      {
        modelId: 'gpt-5-chat-latest',
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
        contextWindow: 128_000,
        maxOutput: 4_096,
      },
      {
        modelId: 'gpt-5-nano',
        capabilities: ['vision', 'tool_use'],
        contextWindow: 128_000,
        maxOutput: 4_096,
      },
      {
        modelId: 'gpt-4o',
        capabilities: ['vision', 'tool_use'],
        contextWindow: 128_000,
        maxOutput: 4_096,
      },
      {
        modelId: 'gpt-4o-mini',
        capabilities: ['vision', 'tool_use'],
        contextWindow: 128_000,
        maxOutput: 4_096,
      },
      {
        modelId: 'o4-mini',
        capabilities: ['vision', 'tool_use', 'reasoning'],
        contextWindow: 200_000,
        maxOutput: 100_000,
      },
      {
        modelId: 'o3-mini',
        capabilities: ['vision', 'tool_use', 'reasoning'],
        contextWindow: 200_000,
        maxOutput: 200_000,
      },
      {
        modelId: 'o3',
        capabilities: ['vision', 'tool_use', 'reasoning'],
        contextWindow: 200_000,
        maxOutput: 100_000,
      },
      {
        modelId: 'text-embedding-3-small',
        type: 'embedding',
      },
    ],
  },
  createModel: (config) => {
    return new OpenAI(
      {
        apiKey: config.providerSetting.apiKey || '',
        apiHost: config.formattedApiHost,
        model: config.model,
        dalleStyle: config.settings.dalleStyle || 'vivid',
        temperature: config.settings.temperature,
        topP: config.settings.topP,
        maxOutputTokens: config.settings.maxTokens,
        injectDefaultMetadata: config.globalSettings.injectDefaultMetadata,
        useProxy: false,
        stream: config.settings.stream,
      },
      config.dependencies
    )
  },
  getDisplayName: (modelId, providerSettings, sessionType) => {
    if (sessionType === 'picture') {
      return 'OpenAI API (DALL-E-3)'
    }
    return `OpenAI API (${providerSettings?.models?.find((m) => m.modelId === modelId)?.nickname || modelId})`
  },
})
