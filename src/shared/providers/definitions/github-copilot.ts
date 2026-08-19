import { createCopilotOAuthFetch, createOAuthCredentialManager } from '../../oauth'
import { ModelProviderType } from '../../types'
import { defineProvider } from '../registry'
import OpenAI from './models/openai'

// The Copilot API base URL (no /v1 prefix)
const COPILOT_API_HOST = 'https://api.githubcopilot.com'

// Headers required by GitHub Copilot API on every request
const COPILOT_API_HEADERS: Record<string, string> = {
  'Openai-Intent': 'conversation-edits',
}

export const githubCopilotProvider = defineProvider({
  id: 'github-copilot',
  name: 'GitHub Copilot',
  type: ModelProviderType.OpenAI,
  urls: {
    website: 'https://github.com/features/copilot',
  },
  defaultSettings: {
    apiHost: COPILOT_API_HOST,
    models: [
      {
        modelId: 'gpt-5.6-sol',
        capabilities: ['vision', 'reasoning', 'tool_use'],
      },
      {
        modelId: 'gpt-5.6-terra',
        capabilities: ['vision', 'reasoning', 'tool_use'],
      },
      {
        modelId: 'gpt-5.6-luna',
        capabilities: ['vision', 'tool_use', 'reasoning'],
      },
      {
        modelId: 'gpt-5.3-codex',
        capabilities: ['vision', 'reasoning', 'tool_use'],
      },
      {
        modelId: 'claude-sonnet-5',
        capabilities: ['vision', 'reasoning', 'tool_use'],
      },
      {
        modelId: 'claude-haiku-4.5',
        capabilities: ['vision', 'reasoning', 'tool_use'],
      },
      {
        modelId: 'gemini-3.6-flash',
        capabilities: ['vision', 'reasoning', 'tool_use'],
      },
      {
        modelId: 'gemini-3.7-flash',
        capabilities: ['vision', 'reasoning', 'tool_use'],
      },
      {
        modelId: 'kimi-k2.7-code',
        capabilities: ['vision', 'reasoning', 'tool_use'],
      },
    ],
  },
  createModel: (config) => {
    const isOAuth = config.providerSetting.activeAuthMode === 'oauth' && !!config.providerSetting.oauth?.accessToken
    const credentialManager = createOAuthCredentialManager(
      'github-copilot',
      config.providerSetting,
      config.dependencies
    )
    return new OpenAI(
      {
        apiKey: isOAuth ? 'oauth-placeholder' : config.effectiveApiKey,
        apiHost: COPILOT_API_HOST,
        model: config.model,
        dalleStyle: 'vivid',
        temperature: config.settings.temperature,
        topP: config.settings.topP,
        maxOutputTokens: config.settings.maxTokens,
        injectDefaultMetadata: config.globalSettings.injectDefaultMetadata,
        useProxy: false,
        stream: config.settings.stream,
        // Copilot API doesn't use /v1 prefix
        skipHostNormalization: true,
        // Copilot API requires these headers
        extraHeaders: COPILOT_API_HEADERS,
        customFetch:
          isOAuth && credentialManager ? createCopilotOAuthFetch(config.dependencies, credentialManager) : undefined,
        listModelsFallback: isOAuth
          ? config.providerSetting.models || githubCopilotProvider.defaultSettings?.models
          : undefined,
        skipRemoteModelList: isOAuth,
      },
      config.dependencies
    )
  },
  getDisplayName: (modelId, providerSettings) => {
    return `GitHub Copilot (${providerSettings?.models?.find((m) => m.modelId === modelId)?.nickname || modelId})`
  },
})
