import { GenerationRuntimeStore } from '@shared/generation/runtime-store'
import { useSyncExternalStore } from 'react'

/**
 * Current Renderer composition instance. A future host creates its own store
 * and injects it through that host's Composition Root.
 */
export const generationRuntimeStore = new GenerationRuntimeStore()

export function getActiveGenerationMessageIds(sessionId: string): ReadonlySet<string> {
  return new Set(generationRuntimeStore.list(sessionId).map((runtime) => runtime.messageId))
}

export function useGenerationRuntimeVersion(): number {
  return useSyncExternalStore(
    (listener) => generationRuntimeStore.subscribe(listener),
    () => generationRuntimeStore.getVersion(),
    () => 0
  )
}

export function useIsGenerationRuntimeActive(sessionId: string, messageId: string): boolean {
  return useSyncExternalStore(
    (listener) => generationRuntimeStore.subscribe(listener),
    () => generationRuntimeStore.get(sessionId, messageId) !== undefined,
    () => false
  )
}
