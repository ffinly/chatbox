/**
 * Explicit React Native model-runtime entrypoint.
 *
 * Unlike `react-native.ts`, importing this module intentionally registers the
 * built-in providers in their historical display order.
 */
import './providers/builtin-registration'

export type { ModelFactoryOptions, ModelResolver } from './application/model'
export { ModelFactory } from './application/model'
export type { ModelInterface } from './models/types'
export {
  getAllProviders,
  getBuiltinProviderIds,
  getModel,
  getProviderDefinition,
  getProviderSettings,
  getSystemProviders,
  hasProvider,
  isBuiltinProviderId,
} from './providers'
export type { Config, ProviderModelInfo, ProviderSettings, SessionSettings, Settings } from './types'
export type { ModelDependencies, OAuthAdapter, RequestAdapter, StorageAdapter } from './types/adapters'
export { ModelProviderEnum, ModelProviderType } from './types/provider'
