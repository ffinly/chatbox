import { ModelProviderEnum, ModelProviderType } from '../../types'
import { defineProvider } from '../registry'
import Perplexity from './models/perplexity'

export const perplexityProvider = defineProvider({
  id: ModelProviderEnum.Perplexity,
  name: 'Perplexity',
  type: ModelProviderType.OpenAI,
  urls: {
    website: 'https://www.perplexity.ai/',
  },
  defaultSettings: {
    models: [
      { modelId: 'sonar' },
      { modelId: 'sonar-pro' },
      { modelId: 'sonar-reasoning' },
      { modelId: 'sonar-reasoning-pro' },
      { modelId: 'sonar-deep-research' },
    ],
  },
  createModel: (config) => {
    return new Perplexity(
      {
        perplexityApiKey: config.providerSetting.apiKey || '',
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
    return `Perplexity API (${providerSettings?.models?.find((m) => m.modelId === modelId)?.nickname || modelId})`
  },
})
