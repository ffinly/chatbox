import { getModel } from '@shared/models'
import { AIProviderNoImplementedPaintError, ChatboxAIAPIError } from '@shared/models/errors'
import type { ImageGeneration, ImageGenerationModel } from '@shared/types'
import { createModelDependencies } from '@/adapters'
import { getLogger } from '@/lib/utils'
import platform from '@/platform'
import storage from '@/storage'
import { StorageKeyGenerator } from '@/storage/StoreStorage'
import { trackEvent } from '@/utils/track'
import {
  addGeneratedImage,
  createRecord,
  IMAGE_GEN_LIST_QUERY_KEY,
  IMAGE_GEN_QUERY_KEY,
  imageGenerationStore,
  updateRecord,
} from './imageGenerationStore'
import { lastUsedModelStore } from './lastUsedModelStore'
import { queryClient } from './queryClient'
import { settingsStore } from './settingsStore'

const log = getLogger('image-generation-actions')

export interface GenerateImageParams {
  prompt: string
  referenceImages: string[]
  model: ImageGenerationModel
  dalleStyle?: 'vivid' | 'natural'
  imageGenerateNum?: number
  aspectRatio?: string
  parentIds?: string[]
}

export function isGenerating(): boolean {
  return imageGenerationStore.getState().currentGeneratingId !== null
}

export async function createAndGenerate(params: GenerateImageParams): Promise<string> {
  const store = imageGenerationStore.getState()

  if (store.currentGeneratingId !== null) {
    throw new Error('Another image is being generated. Please wait.')
  }

  const record = await createRecord({
    prompt: params.prompt,
    referenceImages: params.referenceImages,
    model: params.model,
    dalleStyle: params.dalleStyle,
    imageGenerateNum: params.imageGenerateNum,
    parentIds: params.parentIds,
  })

  store.setCurrentGeneratingId(record.id)
  store.setCurrentRecordId(record.id)
  queryClient.setQueryData([IMAGE_GEN_QUERY_KEY, record.id], record)

  void generateImages(record.id, params).finally(() => {
    imageGenerationStore.getState().setCurrentGeneratingId(null)
    queryClient.invalidateQueries({ queryKey: [IMAGE_GEN_LIST_QUERY_KEY] })
  })

  return record.id
}

async function generateImages(recordId: string, params: GenerateImageParams): Promise<void> {
  try {
    let currentRecord = await updateRecord(recordId, { status: 'generating' })
    if (currentRecord) {
      queryClient.setQueryData([IMAGE_GEN_QUERY_KEY, recordId], currentRecord)
    }

    const globalSettings = settingsStore.getState()
    const dependencies = await createModelDependencies()

    const sessionSettings = {
      provider: params.model.provider,
      modelId: params.model.modelId,
      dalleStyle: params.dalleStyle,
      imageGenerateNum: params.imageGenerateNum,
    }

    const model = getModel(sessionSettings, globalSettings, { uuid: '' }, dependencies)

    if (!model || !model.paint) {
      throw new AIProviderNoImplementedPaintError(params.model.provider)
    }

    lastUsedModelStore.getState().setPictureModel(params.model.provider, params.model.modelId)

    const referenceImageUrls = await Promise.all(
      params.referenceImages.map(async (storageKey) => ({
        imageUrl: await dependencies.storage.getImage(storageKey),
      }))
    )

    trackEvent('generate_image', {
      provider: params.model.provider,
      model: params.model.modelId,
      num_images: params.imageGenerateNum || 1,
      has_reference: params.referenceImages.length > 0,
    })

    await model.paint(
      {
        prompt: params.prompt,
        images: referenceImageUrls.length > 0 ? referenceImageUrls : undefined,
        num: params.imageGenerateNum || 1,
        aspectRatio: params.aspectRatio,
      },
      undefined,
      async (picBase64: string) => {
        const storageKey = StorageKeyGenerator.picture(`image-gen:${recordId}`)
        await storage.setBlob(storageKey, picBase64)

        currentRecord = await addGeneratedImage(recordId, storageKey)
        if (currentRecord) {
          queryClient.setQueryData([IMAGE_GEN_QUERY_KEY, recordId], currentRecord)
          // Also invalidate list to update thumbnails immediately
          queryClient.invalidateQueries({ queryKey: [IMAGE_GEN_LIST_QUERY_KEY] })
        }
      }
    )

    currentRecord = await updateRecord(recordId, { status: 'done' })
    if (currentRecord) {
      queryClient.setQueryData([IMAGE_GEN_QUERY_KEY, recordId], currentRecord)
    }

    log.debug('Image generation completed:', recordId)
  } catch (err: unknown) {
    const error = !(err instanceof Error) ? new Error(`${err}`) : err
    log.error('Image generation failed:', error)

    const errorCode = err instanceof ChatboxAIAPIError ? err.code : undefined
    const updatedRecord = await updateRecord(recordId, {
      status: 'error',
      error: error.message,
      errorCode,
    })
    if (updatedRecord) {
      queryClient.setQueryData([IMAGE_GEN_QUERY_KEY, updatedRecord.id], updatedRecord)
    }
  }
}

export function cancelGeneration(): void {
  const store = imageGenerationStore.getState()
  if (store.currentGeneratingId) {
    void updateRecord(store.currentGeneratingId, {
      status: 'error',
      error: 'Generation cancelled',
    })
    store.setCurrentGeneratingId(null)
  }
}

export async function loadRecord(recordId: string): Promise<ImageGeneration | null> {
  const record = await platform.getImageGenerationStorage().getById(recordId)
  if (record) {
    imageGenerationStore.getState().setCurrentRecordId(record.id)
  }
  return record
}

export function clearCurrentRecord(): void {
  imageGenerationStore.getState().setCurrentRecordId(null)
}

export async function retryGeneration(recordId: string): Promise<void> {
  const store = imageGenerationStore.getState()

  if (store.currentGeneratingId !== null) {
    throw new Error('Another image is being generated. Please wait.')
  }

  const record = await platform.getImageGenerationStorage().getById(recordId)
  if (!record) {
    throw new Error('Record not found')
  }

  store.setCurrentGeneratingId(recordId)

  const params: GenerateImageParams = {
    prompt: record.prompt,
    referenceImages: record.referenceImages,
    model: record.model,
    dalleStyle: record.dalleStyle,
    imageGenerateNum: record.imageGenerateNum,
  }

  void generateImages(recordId, params).finally(() => {
    imageGenerationStore.getState().setCurrentGeneratingId(null)
    queryClient.invalidateQueries({ queryKey: [IMAGE_GEN_LIST_QUERY_KEY] })
  })
}
