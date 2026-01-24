import { ModelProviderEnum, ModelProviderType } from '../../types'
import { defineProvider } from '../registry'
import OpenRouter from './models/openrouter'

export const openRouterProvider = defineProvider({
  id: ModelProviderEnum.OpenRouter,
  name: 'OpenRouter',
  type: ModelProviderType.OpenAI,
  urls: {
    website: 'https://openrouter.ai/',
  },
  defaultSettings: {
    apiHost: 'https://openrouter.ai/api/v1',
    models: [
      {
        modelId: 'google/gemini-3-pro-preview',
        type: 'chat',
        nickname: 'Google: Gemini 3 Pro',
        capabilities: ['tool_use', 'vision'],
        contextWindow: 1048576,
      },
      {
        modelId: 'google/gemini-2.5-pro',
        type: 'chat',
        nickname: 'Google: Gemini 2.5 Pro',
        capabilities: ['tool_use', 'vision'],
        contextWindow: 1048576,
      },
      {
        modelId: 'google/gemini-2.5-flash-image-preview',
        type: 'chat',
        nickname: 'Google: Gemini 2.5 Flash Image Preview',
        capabilities: ['tool_use', 'vision'],
        contextWindow: 32768,
      },
      {
        modelId: 'openai/gpt-5-chat',
        type: 'chat',
        nickname: 'OpenAI: GPT-5 Chat',
        capabilities: ['tool_use', 'vision'],
        contextWindow: 128000,
      },
      {
        modelId: 'openai/gpt-4o-2024-11-20',
        type: 'chat',
        nickname: 'OpenAI: GPT-4o (2024-11-20)',
        capabilities: ['tool_use', 'vision'],
        contextWindow: 128000,
      },
      {
        modelId: 'x-ai/grok-3-mini',
        type: 'chat',
        nickname: 'xAI: Grok 3 Mini',
        capabilities: ['tool_use'],
        contextWindow: 131072,
      },
      {
        modelId: 'deepseek/deepseek-chat-v3.1:free',
        type: 'chat',
        nickname: 'DeepSeek: DeepSeek V3.1 (free)',
        capabilities: ['tool_use'],
        contextWindow: 64000,
      },
      {
        modelId: 'deepseek/deepseek-chat-v3-0324:free',
        type: 'chat',
        nickname: 'DeepSeek: DeepSeek V3 0324 (free)',
        capabilities: ['tool_use'],
        contextWindow: 163840,
      },
      {
        modelId: 'deepseek/deepseek-r1-0528',
        type: 'chat',
        nickname: 'DeepSeek: R1 0528',
        capabilities: ['tool_use'],
        contextWindow: 163840,
      },
      {
        modelId: 'deepseek/deepseek-r1:free',
        type: 'chat',
        nickname: 'DeepSeek: R1 (free)',
        capabilities: ['tool_use'],
        contextWindow: 163840,
      },
      {
        modelId: 'tngtech/deepseek-r1t2-chimera:free',
        type: 'chat',
        nickname: 'TNG: DeepSeek R1T2 Chimera (free)',
        capabilities: ['tool_use'],
        contextWindow: 163840,
      },
    ],
  },
  createModel: (config) => {
    return new OpenRouter(
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
    return `OpenRouter API (${providerSettings?.models?.find((m) => m.modelId === modelId)?.nickname || modelId})`
  },
})
