/** Browser half: render Codex-native trajectory blocks without treating them as Harness tools. */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { CodexAssistantNodeView } from './CodexAssistantNodeView.tsx'
import { CodexSettingsCard } from './CodexSettingsCard.tsx'
import { en, NS, zh } from './locales.ts'
import {
  CODEX_SETTINGS_NAMESPACE,
  CodexSettingsCardController,
} from './settings-card-controller.ts'

/** Required browser services for slot composition and localized presentation. */
export const inject = ['slots', 'locale', 'settingsScope']

/** Register the localized Assistant renderer shadow at a lower cell priority. */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'codex-app-server: browser dictionaries')
  const settings = new CodexSettingsCardController(ctx.settingsScope.bind({
    namespace: CODEX_SETTINGS_NAMESPACE,
  }))
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
    name: 'conversation.chat.node',
    key: 'assistant-step',
    priority: -10,
    locale: NS,
  }, CodexAssistantNodeView))
  ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
    name: 'settings.plugin.item',
    key: CODEX_SETTINGS_NAMESPACE,
    locale: NS,
    inject: () => settings.inject(),
  }, CodexSettingsCard))
}
