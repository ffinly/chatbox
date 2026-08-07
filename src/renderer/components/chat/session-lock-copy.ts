import type { SessionActionBlockReason } from '@shared/session/action-gates'
import type { TFunction } from 'i18next'

/** Map a shared gate block reason to the renderer's user-facing copy. */
export function getSessionLockNotice(reason: SessionActionBlockReason, t: TFunction): string {
  switch (reason) {
    case 'generating':
    case 'message-streaming':
      return t('Wait for the current replies to finish')
    case 'compaction':
      return t('Wait for compaction to finish')
    case 'awaiting-approval':
      return t('Waiting for approval')
  }
}
