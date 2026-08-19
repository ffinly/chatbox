import type { ModelMetadata, ModelRegistryData } from './types'

/**
 * Retired Claude 3 IDs that ChatboxAI still serves. Their real max output is 4096;
 * without this overlay, live models.dev catalogs drop them and
 * getDefaultAnthropicMaxOutputTokens() falls back to 8192, which upstream rejects.
 */
const LEGACY_CLAUDE_MODELS: Record<string, ModelMetadata> = {
  'claude-3-haiku-20240307': {
    modelId: 'claude-3-haiku-20240307',
    name: 'Claude Haiku 3',
    type: 'chat',
    capabilities: ['tool_use', 'vision'],
    contextWindow: 200_000,
    maxOutput: 4_096,
    costInput: 0.25,
    costOutput: 1.25,
    family: 'claude-haiku',
    releaseDate: '2024-03-13',
  },
  'claude-3-sonnet-20240229': {
    modelId: 'claude-3-sonnet-20240229',
    name: 'Claude Sonnet 3',
    type: 'chat',
    capabilities: ['tool_use', 'vision'],
    contextWindow: 200_000,
    maxOutput: 4_096,
    costInput: 3,
    costOutput: 15,
    family: 'claude-sonnet',
    releaseDate: '2024-03-04',
  },
  'claude-3-opus-20240229': {
    modelId: 'claude-3-opus-20240229',
    name: 'Claude Opus 3',
    type: 'chat',
    capabilities: ['tool_use', 'vision'],
    contextWindow: 200_000,
    maxOutput: 4_096,
    costInput: 15,
    costOutput: 75,
    family: 'claude-opus',
    releaseDate: '2024-02-29',
  },
}

/**
 * Merge compatibility metadata into a registry without overwriting live entries.
 */
export function applyRegistryOverlays(registry: ModelRegistryData): ModelRegistryData {
  const existingClaude = registry.claude ?? {}
  const missing = Object.keys(LEGACY_CLAUDE_MODELS).some((modelId) => !existingClaude[modelId])
  if (!missing) return registry

  return {
    ...registry,
    claude: {
      ...LEGACY_CLAUDE_MODELS,
      ...existingClaude,
    },
  }
}
