import platform from '@/platform'
import { trackJkAutoEvent, trackJkClickEvent } from './jk'
import { JK_EVENTS, JK_PAGE_NAMES } from './jk-events'

export type TokenExhaustedCardAction = 'upgrade' | 'buy_token'

export type TokenExhaustedCardTrackingContext = {
  sessionId: string
  mode: 'chat_mode' | 'work_mode'
  action: TokenExhaustedCardAction
  provider?: string
  plan?: string
  model?: string
}

function buildTokenExhaustedCardTrackingOptions(context: TokenExhaustedCardTrackingContext) {
  return {
    pageName: JK_PAGE_NAMES.CHAT_PAGE,
    platform: platform.type === 'web' ? ('web' as const) : ('app' as const),
    content: context.plan ?? null,
    contentType: context.model,
    props: {
      agent_info: {
        content: context.action,
        mode: context.mode,
        session_id: context.sessionId,
      },
      content_add_info: {
        content: context.provider ?? null,
      },
    },
  }
}

export function trackTokenExhaustedCard(context: TokenExhaustedCardTrackingContext) {
  trackJkAutoEvent(JK_EVENTS.TOKEN_EXHAUSTED_CARD, buildTokenExhaustedCardTrackingOptions(context))
}

export function trackTokenExhaustedCardClick(context: TokenExhaustedCardTrackingContext) {
  trackJkClickEvent(JK_EVENTS.TOKEN_EXHAUSTED_CARD_CLICK, buildTokenExhaustedCardTrackingOptions(context))
}
