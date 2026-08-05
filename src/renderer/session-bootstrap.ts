import { registerSessionUiEffects } from '@/presentation/session/session-ui-effects'
import { sessionEvents } from '@/session-runtime'

let cleanup: (() => void) | null = null

/**
 * Renderer composition entry for Presentation-only session effects.
 *
 * Keeping this out of session-runtime prevents the compatibility store facade
 * from pulling React components back into the application/data dependency path.
 */
export function initSessionPresentationBindings(): void {
  if (!cleanup) {
    cleanup = registerSessionUiEffects(sessionEvents)
  }
}
