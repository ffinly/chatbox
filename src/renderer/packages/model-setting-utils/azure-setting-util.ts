import { type ModelProvider, ModelProviderEnum, type ProviderSettings, type SessionType } from '@shared/types'
import BaseConfig from './base-config'
import type { ModelSettingUtil } from './interface'

export default class AzureSettingUtil extends BaseConfig implements ModelSettingUtil {
  public provider: ModelProvider = ModelProviderEnum.Azure
  async getCurrentModelDisplayName(
    model: string,
    sessionType: SessionType,
    providerSettings?: ProviderSettings
  ): Promise<string> {
    if (sessionType === 'picture') {
      return `Azure OpenAI API (${model})`
    } else {
      return `Azure OpenAI API (${providerSettings?.models?.find((m) => m.modelId === model)?.nickname || model})`
    }
  }

  protected async listProviderModels() {
    return []
  }
}
