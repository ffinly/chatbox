import { useSyncExternalStore } from 'react'
import type { GenerationRuntimeState, GenerationRuntimeStore } from '../generation'

export function createGenerationHooks(runtime: GenerationRuntimeStore) {
  return {
    useGeneration(sessionId: string | null): GenerationRuntimeState | undefined {
      return useSyncExternalStore(
        (listener) => runtime.subscribe(listener),
        () => (sessionId ? runtime.get(sessionId) : undefined),
        () => undefined
      )
    },
  }
}
