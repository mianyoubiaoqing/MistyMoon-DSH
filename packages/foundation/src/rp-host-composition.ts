/** RP Host preset-scoped complete Persona and legacy-delivery exclusion. */

import type { Context } from '@deepseek-ai/cordis'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import { PERSONA_ORDER, PERSONA_SECTION } from '@deepseek-ai/dsh-system-prompt'
import { FINAL_REPLY_TOOL } from './final-reply.js'
import type { PublishedPersonaProjection } from './persona-projection.js'
import type { RoleplayController } from './roleplay.js'

/** Cordis plugin name used only inside the versioned RP Host preset. */
export const name = 'mistymoon-rp-host-composition'

/** RP Host needs the shared published snapshot and DSH prompt/tool registries. */
export const inject = ['mistymoonPersonaProjection', 'mistymoonRoleplay', 'systemPrompt', 'tools']

/** Fixed companion route owned by the RP Host preset rather than Persona text. */
export const RP_HOST_MODEL_SELECTION = Object.freeze({
  provider: 'deepseek-official',
  model: 'deepseek-v4-flash',
  reasoningEffort: ReasoningEffortId('high'),
})

/** Complete executable tool surface for the Owner-facing RP Host preset. */
export const RP_HOST_TOOL_ALLOWLIST = Object.freeze([
  'web_search',
  'web_fetch',
  'mistymoon_code_flash',
  'ask_user_question',
])

async function restrictRpHostTools(ctx: Context): Promise<() => void> {
  const scope = scopeOf(ctx)
  if (scope === undefined) throw new Error('mistymoon-rp-host: tool policy requires an Agent scope')
  for (let attempt = 0; attempt < 100; attempt++) {
    const visible = new Set(ctx.tools.schemas(scope).map(tool => tool.name))
    if (RP_HOST_TOOL_ALLOWLIST.every(tool => visible.has(tool))) {
      const deny = [...visible].filter(tool => !RP_HOST_TOOL_ALLOWLIST.includes(tool))
      const liftRestriction = deny.length === 0 ? () => {} : ctx.tools.restrict({ deny })
      const liftGuard = ctx.tools.guard(exec => RP_HOST_TOOL_ALLOWLIST.includes(exec.name)
        ? undefined
        : 'The RP Host may use only read-only Web, Owner confirmation, and fixed Work delegation tools.')
      return () => {
        liftGuard()
        liftRestriction()
      }
    }
    await new Promise<void>(resolve => setTimeout(resolve, 50))
  }
  const visible = new Set(ctx.tools.schemas(scope).map(tool => tool.name))
  const missing = RP_HOST_TOOL_ALLOWLIST.filter(tool => !visible.has(tool))
  throw new Error(`mistymoon-rp-host: required preset tools did not register: ${missing.join(', ')}`)
}

/**
 * Mount the RP-preset-only complete Persona section.
 *
 * The surrounding preset contributes only read-only Web and fixed delegation
 * tools. This module removes the globally available legacy finalization tool;
 * all other presets remain on Foundation's two-phase delivery path.
 */
export async function apply(ctx: Context): Promise<void> {
  const projection = ctx.get('mistymoonPersonaProjection', true) as PublishedPersonaProjection
  const roleplay = ctx.get('mistymoonRoleplay', true) as RoleplayController
  ctx.effect(() => ctx.systemPrompt.section({
    name: PERSONA_SECTION,
    order: PERSONA_ORDER,
    text: (context) => {
      const agent = (context as { agent?: Parameters<RoleplayController['get']>[0] }).agent
      return agent !== undefined && roleplay.get(agent).mode === 'off'
        ? ''
        : projection.current().text
    },
  }), 'mistymoon-rp-host: published Persona system projection')
  await ctx.effect(
    () => restrictRpHostTools(ctx),
    'mistymoon-rp-host: enforce read-only Web and fixed delegation tools',
  )
  ctx.effect(() => installModelSelection(ctx, {
    current: RP_HOST_MODEL_SELECTION,
    assembled: undefined,
  }), 'mistymoon-rp-host: fixed Flash/high model selection')
}
