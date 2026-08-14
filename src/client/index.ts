/** Browser half: render Codex-native trajectory blocks without treating them as Harness tools. */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { CodexAssistantNodeView } from './CodexAssistantNodeView.tsx'
import { en, NS, zh } from './locales.ts'

/** Required browser services for slot composition and localized presentation. */
export const inject = ['slots', 'locale']

/** Register the localized Assistant renderer shadow at a lower cell priority. */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'codex-app-server: browser dictionaries')
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
    name: 'conversation.chat.node',
    key: 'assistant-step',
    priority: -10,
    locale: NS,
  }, CodexAssistantNodeView))
}
