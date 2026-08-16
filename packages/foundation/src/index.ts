/**
 * Private-data bootstrap, RP mode commands, and the two-layer persona
 * delivery coordinator for MistyMoon on DSH.
 * @module @mistymoon/dsh-foundation
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-tools'
import { fileURLToPath } from 'node:url'
import { finalReplyTool, PersonaTurnDeliveryCoordinator } from './final-reply.js'
import { initializePersona } from './persona-home.js'
import { isRoleplayMode, MIN_TURN_VOICE_MAX_CHARS, RoleplayController, type RoleplayMode } from './roleplay.js'

export * from './persona-document.js'
export * from './persona-home.js'
export * from './persona-workspace.js'
export * from './publication.js'
export * from './roleplay.js'
export * from './final-reply.js'

/** Cordis plugin name. */
export const name = 'mistymoon-foundation'

/** The official DSH tool registry that owns the finalization tool. */
export const inject = ['tools']

/** Conservative default UTF-16 character budget for one owner-tail capsule. */
export const DEFAULT_TURN_VOICE_MAX_CHARS = 1200

/** Foundation plugin configuration. */
export interface Config {
  /** User-owned MistyMoon data directory. */
  home: string
  /** RP presentation used until a session records its own selection. */
  defaultRoleplayMode?: RoleplayMode
  /** Inclusive character budget for the once-per-turn owner-tail capsule. */
  turnVoiceMaxChars?: number
}

/** Runtime schema for the foundation plugin. */
export const Config: z<Config> = z.object({
  home: z.string().required(),
  defaultRoleplayMode: z.union(['off', 'companion', 'immersive']).default('companion'),
  turnVoiceMaxChars: z.number().step(1).min(MIN_TURN_VOICE_MAX_CHARS).max(4000).default(DEFAULT_TURN_VOICE_MAX_CHARS),
})

const PERSONA_TEMPLATE = fileURLToPath(new URL('../personas/template/persona.json', import.meta.url))

/**
 * Initialize private first-start state, register the finalization tool, and
 * own owner-tail capsules and the prepared final-voice gate across pre-step,
 * turn-stopping, status, error, and disposal lifecycles. Persona never enters
 * a system-prompt section.
 * @param ctx - Mounting Cordis context with the agent lifecycle.
 * @param config - Private data directory and delivery configuration.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const initialized = await initializePersona({ privateHome: config.home, templatePath: PERSONA_TEMPLATE })
  const defaultMode = config.defaultRoleplayMode ?? 'companion'
  const controller = new RoleplayController(defaultMode)
  const coordinator = new PersonaTurnDeliveryCoordinator({
    defaultMode,
    personaPath: initialized.path,
    turnVoiceMaxChars: config.turnVoiceMaxChars ?? DEFAULT_TURN_VOICE_MAX_CHARS,
    report: (message) => ctx.logger.warn(message),
  })
  ctx.effect(() => ctx.provide('mistymoonRoleplay', controller), 'mistymoon-foundation: RP controller')
  ctx.effect(() => ctx.tools.register(finalReplyTool(coordinator)), 'mistymoon-foundation: final reply tool')
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
  ctx.on('agent/pre-step', async ({ agent, turn }, next) => {
    const decision = await next()
    return coordinator.beforeStep(agent, turn, decision)
  })
  ctx.on('agent/turn-stopping', ({ agent, turn }) => {
    coordinator.finishTurn(agent, turn)
  })
  ctx.on('agent/status', ({ agent, status }) => {
    if (status === 'running') {
      coordinator.onAgentRunning(agent)
    } else {
      coordinator.settle(agent)
    }
  })
  ctx.on('agent/error', ({ agent }) => {
    coordinator.settle(agent)
  })
  ctx.on('agent/disposed', ({ agent }) => {
    coordinator.disposeAgent(agent)
  })
  ctx.effect(() => () => coordinator.dispose(), 'mistymoon-foundation: turn delivery cleanup')
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Per-session MistyMoon RP presentation independent from DSH modes. */
    mistymoonRoleplay: RoleplayController
  }
}
