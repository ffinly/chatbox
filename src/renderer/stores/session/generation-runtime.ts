import { rendererApplication } from '@/app/renderer-application'
import { useSyncExternalStore } from 'react'

/** Compatibility facade for the runtime owned by the Renderer Composition Root. */
export const generationRuntimeStore = rendererApplication.generationRuntime

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
