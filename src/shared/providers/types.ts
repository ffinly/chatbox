import type { ModelInterface } from '../models/types'
import type { Config, ProviderModelInfo, ProviderSettings, SessionSettings, SessionType, Settings } from '../types'
import type { ModelDependencies } from '../types/adapters'
import type { ModelProviderType } from '../types/provider'

/**
 * Configuration for creating a model instance.
 * Contains all the information needed to instantiate a model class.
 */
export interface CreateModelConfig {
  /** Session-level settings (temperature, topP, etc.) */
  settings: SessionSettings
  /** Global application settings */
  globalSettings: Settings
  /** Application configuration (uuid, etc.) */
  config: Config
  /** Platform dependencies (fetch, request, etc.) */
  dependencies: ModelDependencies
  /** Provider-specific settings from globalSettings.providers[providerId] */
  providerSetting: ProviderSettings
  /** The API host, already formatted/trimmed */
  formattedApiHost: string
  /** The API path, resolved from providerSetting or defaults */
  formattedApiPath: string
  /** The selected model configuration */
  model: ProviderModelInfo
}

/**
 * Definition of a provider that can be registered with the provider registry.
 * This consolidates all provider-related information in one place.
 */
export interface ProviderDefinition {
  /** Unique identifier for the provider (matches ModelProviderEnum value) */
  id: string
  /** Display name for the provider */
  name: string
  /** The underlying API type (OpenAI, Claude, Gemini, etc.) */
  type: ModelProviderType
  /** Optional description for the provider */
  description?: string
  /** Related URLs for the provider */
  urls?: {
    website?: string
    apiKey?: string
    docs?: string
    models?: string
  }
  /** Default settings for the provider */
  defaultSettings?: ProviderSettings
  /**
   * Factory function to create a model instance.
   * This replaces the switch statement in getModel().
   */
  createModel: (config: CreateModelConfig) => ModelInterface
  /**
   * Get the display name for a model.
   * Used by the UI to show the model name in message headers.
   */
  getDisplayName?: (
    modelId: string,
    providerSettings?: ProviderSettings,
    sessionType?: SessionType
  ) => string | Promise<string>
}

/**
 * Input type for defineProvider - allows partial definition
 * with required fields only.
 */
export type ProviderDefinitionInput = Omit<ProviderDefinition, 'id'> & {
  id: string
}
