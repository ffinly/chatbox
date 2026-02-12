import { type ModelProvider, ModelProviderEnum, type ProviderSettings, type SessionType } from '@shared/types'
import BaseConfig from './base-config'
import type { ModelSettingUtil } from './interface'

export default class VolcEngineSettingUtil extends BaseConfig implements ModelSettingUtil {
  public provider: ModelProvider = ModelProviderEnum.VolcEngine
  async getCurrentModelDisplayName(
    model: string,
    sessionType: SessionType,
    providerSettings?: ProviderSettings
  ): Promise<string> {
    return `VolcEngine API (${providerSettings?.models?.find((m) => m.modelId === model)?.nickname || model})`
  }

  protected async listProviderModels(settings: ProviderSettings) {
    return []
  }
}
