import { ModelProviderEnum, ModelProviderType } from '../../types'
import { defineProvider } from '../registry'
import Groq from './models/groq'

export const groqProvider = defineProvider({
  id: ModelProviderEnum.Groq,
  name: 'Groq',
  type: ModelProviderType.OpenAI,
  urls: {
    website: 'https://groq.com/',
  },
  defaultSettings: {
    apiHost: 'https://api.groq.com/openai',
    models: [
      {
        modelId: 'llama-3.3-70b-versatile',
        contextWindow: 131_072,
        maxOutput: 32_768,
        capabilities: ['tool_use'],
      },
      {
        modelId: 'moonshotai/kimi-k2-instruct',
        contextWindow: 131_072,
        maxOutput: 16_384,
        capabilities: ['tool_use'],
      },
      {
        modelId: 'qwen/qwen3-32b',
        contextWindow: 131_072,
        maxOutput: 40_960,
        capabilities: ['tool_use'],
      },
    ],
  },
  createModel: (config) => {
    return new Groq(
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
    return `Groq API (${providerSettings?.models?.find((m) => m.modelId === modelId)?.nickname || modelId})`
  },
})
