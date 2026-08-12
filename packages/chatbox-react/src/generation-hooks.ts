import type { GenerationRuntimeState, GenerationRuntimeStore } from '@chatbox/core'
import { useSyncExternalStore } from 'react'

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
