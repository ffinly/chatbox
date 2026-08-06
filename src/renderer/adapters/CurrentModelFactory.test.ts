import type { ModelInterface } from '@shared/models/types'
import type { SessionSettings } from '@shared/types'
import { describe, expect, test, vi } from 'vitest'
import { CurrentModelFactory } from './CurrentModelFactory'

describe('CurrentModelFactory', () => {
  test('delegates model creation without changing settings', async () => {
    const model = {
      name: 'Test model',
      modelId: 'test-model',
    } as ModelInterface
    const create = vi.fn(() => Promise.resolve(model))
    const factory = new CurrentModelFactory(create)
    const settings: SessionSettings = {
      provider: 'openai',
      modelId: 'gpt-4.1',
      temperature: 0.4,
    }

    await expect(factory.createModel(settings)).resolves.toBe(model)
    expect(create).toHaveBeenCalledWith(settings)
  })
})
