import { type ModelProvider, ModelProviderEnum, type ProviderSettings } from '@shared/types'
import BaseConfig from './base-config'
import type { ModelSettingUtil } from './interface'

export default class ChatGLMSettingUtil extends BaseConfig implements ModelSettingUtil {
  public provider: ModelProvider = ModelProviderEnum.ChatGLM6B
  async getCurrentModelDisplayName(model: string): Promise<string> {
    return model
  }

  protected async listProviderModels(settings: ProviderSettings) {
    return []
  }
}
