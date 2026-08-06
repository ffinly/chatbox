import { GenerationRuntimeStore } from '@shared/generation/runtime-store'

/**
 * Current Renderer composition instance. A future host creates its own store
 * and injects it through that host's Composition Root.
 */
export const generationRuntimeStore = new GenerationRuntimeStore()
