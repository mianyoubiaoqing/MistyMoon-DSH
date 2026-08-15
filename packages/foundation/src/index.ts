/**
 * Private-data bootstrap and publication safety for MistyMoon on DSH.
 * @module @mistymoon/dsh-foundation
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-commands'
import { fileURLToPath } from 'node:url'
import { loadPersona } from './persona-document.js'
import { initializePersona } from './persona-home.js'
import { isRoleplayMode, projectRoleplay, RoleplayController, type RoleplayMode } from './roleplay.js'

export * from './persona-document.js'
export * from './persona-home.js'
export * from './persona-workspace.js'
export * from './publication.js'
export * from './roleplay.js'

/** Cordis plugin name. */
export const name = 'mistymoon-foundation'

/** Foundation plugin configuration. */
export interface Config {
  /** User-owned MistyMoon data directory. */
  home: string
  /** RP presentation used until a session records its own selection. */
  defaultRoleplayMode?: RoleplayMode
}

/** Runtime schema for the foundation plugin. */
export const Config: z<Config> = z.object({
  home: z.string().required(),
  defaultRoleplayMode: z.union(['off', 'companion', 'immersive']).default('companion'),
})

const PERSONA_TEMPLATE = fileURLToPath(new URL('../personas/template/persona.json', import.meta.url))

/**
 * Initialize private first-start state and project RP as logged user-owned context.
 * @param ctx - Mounting Cordis context with the agent lifecycle.
 * @param config - Private data directory configuration.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const initialized = await initializePersona({ privateHome: config.home, templatePath: PERSONA_TEMPLATE })
  const defaultMode = config.defaultRoleplayMode ?? 'companion'
  const controller = new RoleplayController(defaultMode)
  ctx.effect(() => ctx.provide('mistymoonRoleplay', controller), 'mistymoon-foundation: RP controller')
  ctx.inject(['commands'], (commandCtx) => commandCtx.commands.register({
    name: 'rp',
    description: 'Select MistyMoon RP presentation without changing the DSH agent preset or mode',
    input: { hint: '[off|companion|immersive]' },
    recordInput: false,
    handler: ({ agent, rawInput }) => {
      const requested = rawInput.trim()
      if (requested === '') {
        const state = controller.get(agent)
        return {
          kind: 'success',
          text: `MistyMoon RP is ${state.mode}.`,
        }
      }
      if (!isRoleplayMode(requested)) {
        return { kind: 'error', text: 'RP level must be off, companion, or immersive.' }
      }
      return {
        kind: 'success',
        text: `MistyMoon RP is ${requested}.`,
      }
    },
  }))
  ctx.on('agent/pre-step', async ({ agent, step }, next): Promise<PreStepDecision> => {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    const mode = controller.get(agent).mode
    return projectRoleplay(decision, await loadPersona(initialized.path), mode, step)
  }, { prepend: true })
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Per-session MistyMoon RP presentation independent from DSH modes. */
    mistymoonRoleplay: RoleplayController
  }
}
