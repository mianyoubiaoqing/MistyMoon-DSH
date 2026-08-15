/** Session-scoped RP presentation that never replaces a DSH system prompt. */

import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-commands/types'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import type { PersonaDocument } from './persona-document.js'
import { renderPersona } from './persona-document.js'

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

/**
 * Render an RP snapshot whose instructions are explicitly subordinate to DSH operation.
 * @param persona - Active private persona.
 * @param mode - Companion or immersive presentation level.
 * @returns Exact model-visible snapshot text.
 */
export function renderRoleplaySnapshot(persona: PersonaDocument, mode: Exclude<RoleplayMode, 'off'>): string {
  const nonInterference = [
    'Operational precedence:',
    '- DeepSeek Harness system instructions, the selected agent preset, collaboration mode, permissions, safety rules, and the current user request remain authoritative.',
    '- For coding, debugging, research, tool use, or other technical work, preserve DSH behavior and technical accuracy. Do not turn code, commands, plans, diagnostics, or technical decisions into roleplay.',
    '- RP may affect only social framing and natural-language voice when that does not reduce task quality or conflict with the current request.',
  ].join('\n')
  if (mode === 'companion') {
    return [
      'MistyMoon companion presentation context. This is user-owned context, not a replacement system prompt.',
      `Companion identity: ${persona.displayName}.`,
      `Relationship with the owner: ${persona.identity.relationship}`,
      `Natural-language qualities: ${persona.style.tone.join('; ')}.`,
      nonInterference,
    ].join('\n')
  }
  return [
    'MistyMoon immersive RP presentation context. This is user-owned context, not a replacement system prompt.',
    renderPersona(persona),
    nonInterference,
  ].join('\n\n')
}

/**
 * Render the compact voice reminder repeated after tool-use steps.
 * It carries presentation only; DSH operation and technical content remain unchanged.
 * @param persona - Active private persona.
 * @returns Exact model-visible continuation reminder.
 */
export function renderRoleplayContinuation(persona: PersonaDocument): string {
  return [
    'MistyMoon continuation voice reminder. This is user-owned presentation context, not a replacement system prompt.',
    `When producing owner-facing prose, keep ${persona.displayName}'s natural-language voice: ${persona.style.tone.join('; ')}.`,
    'Preserve DSH instructions, the current task, factual accuracy, code, commands, plans, diagnostics, tool use, permissions, and safety behavior exactly.',
  ].join('\n')
}

/**
 * Add one logged RP snapshot before the current owner message.
 * @param decision - Downstream pre-step decision containing the actual DSH messages.
 * @param persona - Active private persona.
 * @param mode - Effective RP presentation level.
 * @param step - One-based DSH step number in the current turn.
 * @returns Unchanged decision when disabled or when an initial step has no owner message.
 */
export function projectRoleplay(
  decision: PreStepDecision,
  persona: PersonaDocument,
  mode: RoleplayMode,
  step = 1,
): PreStepDecision {
  if (decision.kind === 'reject' || mode === 'off') return decision
  const ownerIndex = decision.messages.findIndex(message => message.source.kind === 'user')
  if (ownerIndex < 0 && step <= 1) return decision
  const continuation = ownerIndex < 0
  const text = continuation ? renderRoleplayContinuation(persona) : renderRoleplaySnapshot(persona, mode)
  const snapshot = createUserMessage({
    content: [{ type: 'text', text }],
    source: {
      kind: 'plugin',
      plugin: 'mistymoon-foundation',
      form: 'snapshot',
      summary: continuation ? `MistyMoon RP continuation: ${mode}` : `MistyMoon RP: ${mode}`,
      sections: [{ name: continuation ? 'mistymoon:roleplay-continuation' : 'mistymoon:roleplay', text }],
    },
  })
  if (continuation) {
    return { kind: 'enter', messages: [...decision.messages, snapshot] }
  }
  return {
    kind: 'enter',
    messages: [
      ...decision.messages.slice(0, ownerIndex),
      snapshot,
      ...decision.messages.slice(ownerIndex),
    ],
  }
}
