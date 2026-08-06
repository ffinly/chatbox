import { ModelFactory } from '@shared/application/model'
import { getModel } from '@shared/models'
import type { ModelInterface } from '@shared/models/types'
import type { ModelFactoryPort } from '@shared/ports'
import type { SessionSettings } from '@shared/types'
import type { ModelDependencies } from '@shared/types/adapters'
import platform from '@/platform'
import { settingsService } from '@/settings-runtime'
import { createModelDependencies } from './RendererModelDependencies'

export type CurrentModelCreator = (
  settings: SessionSettings,
  dependencies?: ModelDependencies
) => Promise<ModelInterface>

const sharedModelFactory = new ModelFactory({
  settingsRepository: settingsService,
  loadConfig: () => platform.getConfig(),
  createDependencies: () => createModelDependencies(),
  resolveModel: getModel,
})

const createWithCurrentImplementation: CurrentModelCreator = (settings, dependencies) =>
  sharedModelFactory.createModel(settings, dependencies)

/**
 * Current-host facade over the shared ModelFactory application service.
 */
export class CurrentModelFactory implements ModelFactoryPort {
  constructor(private readonly create: CurrentModelCreator = createWithCurrentImplementation) {}

  createModel(settings: SessionSettings, dependencies?: ModelDependencies): Promise<ModelInterface> {
    return dependencies === undefined ? this.create(settings) : this.create(settings, dependencies)
  }
}

export const currentModelFactory = new CurrentModelFactory()
