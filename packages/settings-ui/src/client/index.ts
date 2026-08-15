/** Browser half of the local MistyMoon settings plugin. */

import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { MistyMoonSettingsSnapshot } from '../index.js'
import { MistyMoonSettingsTab, type MistyMoonSettingsTabInjected } from './MistyMoonSettingsTab.js'
import { en, zh, type MistyMoonSettingsLocaleKey } from './locales.js'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Local-only MistyMoon settings copy. */
    'settings.mistymoon': MistyMoonSettingsLocaleKey
  }
}

/** Required browser services. */
export const inject = ['slots', 'locale', 'connection']

const NS = 'settings.mistymoon'
const STYLE_ID = '@mistymoon/dsh/settings-ui'

const CSS = `
.mistymoon-settings{width:100%;max-width:760px;color:var(--dsw-alias-label-primary);display:flex;flex-direction:column;gap:16px}
.mistymoon-settings header h3,.mistymoon-settings header p,.mistymoon-status,.mistymoon-error p,.mistymoon-validation,.mistymoon-success{margin:0}
.mistymoon-settings header{display:flex;flex-direction:column;gap:6px}.mistymoon-settings header p,.mistymoon-settings small,.mistymoon-status{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:20px}
.mistymoon-settings fieldset{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:10px;padding:14px;display:flex;flex-direction:column;gap:12px}
.mistymoon-settings legend{padding:0 6px;font-size:14px;font-weight:600}.mistymoon-settings label{display:flex;flex-direction:column;gap:6px;font-size:13px;font-weight:500}
.mistymoon-settings input,.mistymoon-settings textarea{box-sizing:border-box;width:100%;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;border-radius:8px;padding:8px 10px;outline:none}
.mistymoon-settings input:focus-visible,.mistymoon-settings textarea:focus-visible{border-color:var(--dsw-alias-state-business-primary);box-shadow:0 0 0 2px color-mix(in srgb,var(--dsw-alias-state-business-primary) 18%,transparent)}
.mistymoon-settings textarea{resize:vertical;line-height:20px}.mistymoon-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.mistymoon-settings .mistymoon-check{flex-direction:row;align-items:center;font-weight:400}.mistymoon-check input{width:16px;height:16px;margin:0}
.mistymoon-actions{display:flex;justify-content:flex-end}.mistymoon-actions button,.mistymoon-error button{border:0;background:var(--dsw-alias-state-business-primary);color:#fff;font:inherit;border-radius:8px;padding:8px 16px;cursor:pointer}.mistymoon-actions button:disabled{opacity:.5;cursor:not-allowed}
.mistymoon-validation,.mistymoon-error{color:var(--dsw-alias-state-error-primary);font-size:13px}.mistymoon-success{color:var(--dsw-alias-state-success-primary);font-size:13px}.mistymoon-error{display:flex;align-items:center;gap:10px}
@media (max-width:680px){.mistymoon-grid{grid-template-columns:minmax(0,1fr)}}`

function snapshot(value: unknown): MistyMoonSettingsSnapshot {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('invalid MistyMoon settings response')
  const record = value as Record<string, unknown>
  if (typeof record.persona !== 'object' || record.persona === null || !Number.isSafeInteger(record.recallLimit)) {
    throw new Error('invalid MistyMoon settings response')
  }
  return record as unknown as MistyMoonSettingsSnapshot
}

/** Register the MistyMoon tab in the Plugins settings section. */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'mistymoon-settings-ui: dictionaries')
  ctx.effect(() => {
    const style = document.createElement('style')
    style.dataset.pluginCss = STYLE_ID
    style.textContent = CSS
    document.head.appendChild(style)
    return () => { style.remove() }
  }, 'mistymoon-settings-ui: styles')

  // The package emits Host and Client faces from one project; declaration
  // merging therefore exposes the Host connection type here even though this
  // entry only runs in the browser module graph.
  const connection = ctx.get('connection') as unknown as ConnectionHandle
  const call = async (endpoint: 'read' | 'save', payload: unknown): Promise<MistyMoonSettingsSnapshot> => {
    const result = await connection.rpc.call('/mistymoon-settings', endpoint, payload)
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
    return snapshot(result.value)
  }
  const injected: MistyMoonSettingsTabInjected = {
    read: () => call('read', {}),
    save: settings => call('save', { settings }),
  }
  const t = ctx.locale.bind(NS)
  ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
    name: 'settings.plugins.tab',
    id: 'mistymoon',
    order: 5,
    label: () => t('tab'),
    locale: NS,
    inject: () => injected,
  }, MistyMoonSettingsTab))
}

export type { MistyMoonSettingsTabInjected, MistyMoonSettingsTabProps } from './MistyMoonSettingsTab.js'
export type { MistyMoonSettingsLocaleKey } from './locales.js'
