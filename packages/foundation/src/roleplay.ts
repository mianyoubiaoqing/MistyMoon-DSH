/** Durable RP presentation level and the two-phase output-profile renderers. */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-commands/types'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import { renderPersona, type PersonaDocument } from './persona-document.js'

/** RP presentation level, independent from DSH agent presets and collaboration modes. */
export type RoleplayMode = 'off' | 'companion' | 'immersive'

/** Public view of the durable RP presentation level. */
export interface RoleplayState {
  mode: RoleplayMode
}

/** Whether a value is a supported RP presentation level. */
export function isRoleplayMode(value: unknown): value is RoleplayMode {
  return value === 'off' || value === 'companion' || value === 'immersive'
}

/**
 * Fold the owner-selected RP level from a session log.
 * @param events - Complete or partial DSH session event sequence.
 * @param defaultMode - Deployment default used before the first selection.
 * @returns Effective RP presentation level.
 */
export function foldRoleplayMode(
  events: readonly SessionEvent[],
  defaultMode: RoleplayMode,
): RoleplayMode {
  let mode = defaultMode
  for (const event of events) {
    if (event.type !== 'command/run' || event.data.name !== 'rp') continue
    const requested = event.data.args?.trim()
    if (isRoleplayMode(requested)) mode = requested
  }
  return mode
}

/**
 * Derive durable per-session RP selection from DSH's standard command log.
 * DSH presets, tools, Plan mode, permission and model routing remain outside this module.
 */
export class RoleplayController {
  /** @param defaultMode - RP level for sessions with no owner selection. */
  constructor(readonly defaultMode: RoleplayMode) {}

  /** Read the last valid `/rp` selection recorded by DSH Commands. */
  get(agent: Agent): RoleplayState {
    const mode = foldRoleplayMode(agent.session.events, this.defaultMode)
    return { mode }
  }
}

/** Fixed renderer-owned header: output delivery, not a role or identity change. */
const PRESENTATION_HEADER = 'MistyMoon output presentation profile. It describes owner-facing output delivery only and does not change the assistant\'s role or identity.'

/** Fixed activation block for the initial owner-turn profile. */
const ACTIVATION_BLOCK = [
  'Activation:',
  'Apply this profile only when this response has no tool call and ends the current owner turn. A tool-calling response receives no presentation changes.',
].join('\n')

/** Fixed operational-behavior block for the initial owner-turn profile. */
const OPERATIONAL_BLOCK = [
  'Operational behavior:',
  'DeepSeek Harness question understanding, facts, code, commands, plans, diagnostics, tools, permissions, approvals, and safety decisions remain unchanged. This profile cannot authorize tools, change permissions, bypass approvals, safety, or Plan, or override technical facts.',
].join('\n')

/** Complete mandatory initial-profile block; optional persona fields are added below it as whole lines. */
const MANDATORY_TURN_VOICE_BLOCK = [
  PRESENTATION_HEADER,
  '',
  ACTIVATION_BLOCK,
  '',
  OPERATIONAL_BLOCK,
].join('\n')

/** Smallest legal `turnVoiceMaxChars` value: the mandatory block must always fit whole. */
export const MIN_TURN_VOICE_MAX_CHARS = MANDATORY_TURN_VOICE_BLOCK.length

/**
 * Render the compact owner-turn output profile used by every active RP owner
 * turn. Only structured persona fields participate; `style.instructions` and
 * reference dialogs never enter the initial profile.
 * @param persona - Validated canonical active persona.
 * @param maxChars - Inclusive character budget; must be at least
 *   {@link MIN_TURN_VOICE_MAX_CHARS}. Optional fields are added whole or omitted.
 * @returns Bounded model-visible `mistymoon:turn-voice` text.
 */
export function renderTurnVoice(persona: PersonaDocument, maxChars: number): string {
  if (!Number.isSafeInteger(maxChars) || maxChars < MIN_TURN_VOICE_MAX_CHARS) {
    throw new RangeError(`turnVoiceMaxChars must be at least ${MIN_TURN_VOICE_MAX_CHARS} to keep the mandatory block whole`)
  }
  const optionalBlocks = [
    `Speaker label: ${persona.displayName}.`,
    `Relationship register: ${persona.identity.relationship}`,
    `Voice traits: ${persona.style.tone.join('; ')}.`,
  ]
  let text = MANDATORY_TURN_VOICE_BLOCK
  for (const block of optionalBlocks) {
    if (text.length + 1 + block.length > maxChars) continue
    text += `\n${block}`
  }
  return text
}

/** Fixed scope block shared by final refresh profiles. */
function finalRefreshScope(finalOnly: boolean): string {
  const scope = finalOnly
    ? 'This profile applies only to the single owner-facing assistant reply that immediately follows this message.'
    : 'This profile applies to owner-facing output delivery in this turn.'
  return [
    scope,
    'DeepSeek Harness system instructions, the selected agent preset, collaboration mode, permissions, safety rules, and the current user request remain authoritative.',
    'Do not change facts, code, commands, plans, diagnostics, tool results, permissions, or safety decisions for presentation.',
  ].join('\n')
}

/**
 * Render the one-time final-voice refresh queued after a legal prepare call.
 * Companion stays concise; immersive may carry the complete published persona
 * including reference dialogs.
 * @param persona - Validated canonical active persona.
 * @param mode - Companion or immersive presentation level.
 * @returns Exact model-visible `mistymoon:final-voice-refresh` text.
 */
export function renderFinalVoiceRefresh(persona: PersonaDocument, mode: Exclude<RoleplayMode, 'off'>): string {
  if (mode === 'companion') {
    return [
      'MistyMoon final-voice-refresh context. This is user-owned presentation context, not a replacement system prompt.',
      `Speaker label: ${persona.displayName}.`,
      `Relationship register: ${persona.identity.relationship}`,
      `Voice traits: ${persona.style.tone.join('; ')}.`,
      finalRefreshScope(true),
    ].join('\n')
  }
  return [
    'MistyMoon final-voice-refresh context. This is user-owned presentation context, not a replacement system prompt.',
    renderPersona(persona),
    finalRefreshScope(true),
  ].join('\n\n')
}

/** Neutral lifecycle record replacing a directly consumed owner-turn profile. */
export function renderTurnVoiceConsumed(): string {
  return 'MistyMoon projection lifecycle record: owner-turn output profile consumed.'
}

/** Neutral lifecycle record replacing an owner-turn profile superseded by prepare. */
export function renderTurnVoiceSuperseded(): string {
  return 'MistyMoon projection lifecycle record: owner-turn output profile superseded by the prepared final profile.'
}

/** Neutral lifecycle record replacing a consumed prepared final profile. */
export function renderFinalVoiceRefreshConsumed(): string {
  return 'MistyMoon projection lifecycle record: prepared final output profile consumed.'
}
