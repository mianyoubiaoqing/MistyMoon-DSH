/**
 * Deep two-phase output-profile delivery: one bounded owner-turn profile per
 * owner turn, superseded by an explicit final-voice-refresh gate for long tasks.
 */

import { createHash } from 'node:crypto'
import { assembleContextFor, type Agent, type PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage, type AssistantMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session/types'
import { defineTool, type ToolDefinition, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { loadPersona, type PersonaDocument } from './persona-document.js'
import {
  foldRoleplayMode,
  MIN_TURN_VOICE_MAX_CHARS,
  renderFinalVoiceRefresh,
  renderFinalVoiceRefreshConsumed,
  renderTurnVoice,
  renderTurnVoiceConsumed,
  renderTurnVoiceSuperseded,
  type RoleplayMode,
} from './roleplay.js'

/** Model-visible finalization tool name. */
export const FINAL_REPLY_TOOL = 'mistymoon_prepare_final_reply'

/** Durable source plugin for all projection messages. */
export const VOICE_PLUGIN = 'mistymoon-foundation'

/** Durable context form for all projection messages. */
export const VOICE_FORM = 'snapshot'

/** One model-visible projection kind owned by the coordinator. */
export type VoiceProjection =
  | 'turn-voice'
  | 'final-voice-refresh'
  | 'turn-voice-consumed'
  | 'turn-voice-superseded'
  | 'final-voice-refresh-consumed'

/** Active owner-turn profile section name. */
export const TURN_VOICE_SECTION = 'mistymoon:turn-voice'

/** Active prepared final profile section name. */
export const FINAL_VOICE_REFRESH_SECTION = 'mistymoon:final-voice-refresh'

/** Lifecycle record for a directly consumed owner-turn profile. */
export const TURN_VOICE_CONSUMED_SECTION = 'mistymoon:turn-voice-consumed'

/** Lifecycle record for an owner-turn profile superseded by prepare. */
export const TURN_VOICE_SUPERSEDED_SECTION = 'mistymoon:turn-voice-superseded'

/** Lifecycle record for a consumed prepared final profile. */
export const FINAL_VOICE_REFRESH_CONSUMED_SECTION = 'mistymoon:final-voice-refresh-consumed'

/** Section names emitted by the superseded dual-active implementation. */
export const LEGACY_TURN_VOICE_EXPIRED_SECTION = 'mistymoon:turn-voice-expired'

/** Expiry section name emitted by the superseded dual-active implementation. */
export const LEGACY_FINAL_VOICE_REFRESH_EXPIRED_SECTION = 'mistymoon:final-voice-refresh-expired'

/**
 * Durable, non-private source identity for a model-visible voice message.
 * The hash identifies the published persona without carrying its text.
 */
export interface MistymoonVoiceSource {
  kind: 'mistymoon-voice'
  plugin: typeof VOICE_PLUGIN
  form: typeof VOICE_FORM
  sections: readonly {
    readonly name: string
    readonly text: string
  }[]
  projection: VoiceProjection
  turn: number
  estimatedTokens: number
  personaVersion?: number
  personaHash?: string
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'mistymoon-voice': MistymoonVoiceSource
  }
}

/** Canonical prepare outcomes; no persona content is ever rendered from these. */
export type PrepareStatus = 'armed' | 'roleplay-off' | 'duplicate' | 'refused'

/** Canonical, schema-validated prepare result. */
export interface PrepareResult {
  status: PrepareStatus
}

/** Durable neutral tool-result metadata written for every prepare execution. */
interface PreparePresentationMeta {
  kind: 'mistymoon-prepare'
  status: PrepareStatus
}

/** Neutral model-facing text for each canonical prepare outcome. */
const PREPARE_RENDER: Record<PrepareStatus, string> = {
  armed: 'Final reply prepared: the next assistant output is the owner-facing final reply, with no tools available.',
  'roleplay-off': 'Roleplay is off; no final-voice context was added.',
  duplicate: 'Final reply is already prepared for this turn.',
  refused: 'Final reply preparation refused: call this tool alone, only after all work is complete.',
}

/** One prepared final gate: exactly one refresh and one Agent-scoped restriction. */
interface ArmedRefresh {
  turn: number
  voice: UserMessage
  liftRestriction: () => void
}

/** Live per-agent state owned by the coordinator; never inspected by callers. */
interface LiveAgentState {
  agent: Agent
  capsuleTurn?: number
  armed?: ArmedRefresh
}

/** Configuration owned by the coordinator. */
export interface PersonaTurnDeliveryConfig {
  /** RP level for sessions with no owner selection. */
  defaultMode: RoleplayMode
  /** Absolute path of the user-owned active persona document. */
  personaPath: string
  /** Inclusive character budget for the initial turn profile. */
  turnVoiceMaxChars: number
  /** Neutral diagnostic sink; defaults to a no-op for direct construction. */
  report?: (message: string) => void
}

/** Stable fingerprint of a published persona: schema version plus content hash. */
interface PersonaFingerprint {
  version: number
  hash: string
}

function sectionFor(projection: VoiceProjection): string {
  switch (projection) {
    case 'turn-voice': return TURN_VOICE_SECTION
    case 'final-voice-refresh': return FINAL_VOICE_REFRESH_SECTION
    case 'turn-voice-consumed': return TURN_VOICE_CONSUMED_SECTION
    case 'turn-voice-superseded': return TURN_VOICE_SUPERSEDED_SECTION
    case 'final-voice-refresh-consumed': return FINAL_VOICE_REFRESH_CONSUMED_SECTION
  }
}

/** Whether a projection participates in exactly-one active-profile accounting. */
export function isActiveVoiceProjection(projection: VoiceProjection | undefined): boolean {
  return projection === 'turn-voice' || projection === 'final-voice-refresh'
}

const KNOWN_VOICE_PROJECTIONS: readonly VoiceProjection[] = [
  'turn-voice',
  'final-voice-refresh',
  'turn-voice-consumed',
  'turn-voice-superseded',
  'final-voice-refresh-consumed',
]

/** Durable source projection of one message, including neutral lifecycle records. */
export function voiceProjectionOf(source: unknown): VoiceProjection | undefined {
  if (typeof source !== 'object' || source === null) return undefined
  const record = source as Record<string, unknown>
  if (record['kind'] !== 'mistymoon-voice'
    || record['plugin'] !== VOICE_PLUGIN
    || record['form'] !== VOICE_FORM) return undefined
  const projection = record['projection']
  if (typeof projection !== 'string') return undefined
  return KNOWN_VOICE_PROJECTIONS.includes(projection as VoiceProjection)
    ? projection as VoiceProjection
    : undefined
}

/** Durable owner-turn stored on one voice source. */
function voiceTurnOf(source: unknown): number | undefined {
  if (typeof source !== 'object' || source === null) return undefined
  const turn = (source as Record<string, unknown>)['turn']
  return typeof turn === 'number' && Number.isSafeInteger(turn) ? turn : undefined
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4))
}

function personaFingerprint(persona: PersonaDocument): PersonaFingerprint {
  return {
    version: persona.schemaVersion,
    hash: createHash('sha256').update(JSON.stringify(persona), 'utf8').digest('hex'),
  }
}

function createVoiceMessage(
  text: string,
  projection: VoiceProjection,
  turn: number,
  fingerprint?: PersonaFingerprint,
): UserMessage {
  const source: MistymoonVoiceSource = {
    kind: 'mistymoon-voice',
    plugin: VOICE_PLUGIN,
    form: VOICE_FORM,
    sections: [{ name: sectionFor(projection), text }],
    projection,
    turn,
    estimatedTokens: estimateTokens(text),
    ...(fingerprint === undefined ? {} : { personaVersion: fingerprint.version, personaHash: fingerprint.hash }),
  }
  return createUserMessage({
    content: [{ type: 'text', text }],
    source,
  })
}

/** Find one event by durable sequence, supporting direct arrays and windowed logs. */
function eventAt(events: readonly SessionEvent[], seq: number): SessionEvent | undefined {
  const direct = events[seq]
  if (direct?.seq === seq) return direct
  for (const event of events) {
    if (event.seq === seq) return event
  }
  return undefined
}

/** Whether one message carries the active final-voice-refresh projection. */
function isFinalRefreshMessage(message: UserMessage, turn?: number): boolean {
  const projection = voiceProjectionOf(message.source)
  if (projection !== 'final-voice-refresh') return false
  if (turn === undefined) return true
  return voiceTurnOf(message.source) === turn
}

/** Latest `step/start` fact from the durable log. */
function latestStepStart(agent: Agent): { turn: number; step: number } | undefined {
  for (let index = agent.session.events.length - 1; index >= 0; index--) {
    const event = agent.session.events[index]
    if (event?.type === 'step/start') return event.data
  }
  return undefined
}

/** The assistant message that owns one logged step. */
function assistantForStep(agent: Agent, step: { turn: number; step: number }): { message: AssistantMessage } | undefined {
  for (let index = agent.session.events.length - 1; index >= 0; index--) {
    const event = agent.session.events[index]
    if (event?.type !== 'assistant/message') continue
    if (event.data.turn !== step.turn || event.data.step !== step.step) continue
    return { message: event.data.message }
  }
  return undefined
}

/** Durable prepare metadata; only successful tool executions carry it. */
function prepareMetaOf(value: unknown): PreparePresentationMeta | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  if (record['kind'] !== 'mistymoon-prepare' || typeof record['status'] !== 'string') return undefined
  return { kind: 'mistymoon-prepare', status: record['status'] as PrepareStatus }
}

/** Neutral lifecycle text for one replacement projection. */
function lifecycleText(projection: VoiceProjection): string {
  switch (projection) {
    case 'turn-voice-consumed': return renderTurnVoiceConsumed()
    case 'turn-voice-superseded': return renderTurnVoiceSuperseded()
    case 'final-voice-refresh-consumed': return renderFinalVoiceRefreshConsumed()
    case 'turn-voice':
    case 'final-voice-refresh':
      throw new Error(`active projection "${projection}" has no lifecycle text`)
  }
}

/** Replacement projection for one active projection and transition reason. */
function replacementFor(active: VoiceProjection, reason: 'consumed' | 'superseded'): VoiceProjection {
  if (active === 'turn-voice') {
    return reason === 'superseded' ? 'turn-voice-superseded' : 'turn-voice-consumed'
  }
  return 'final-voice-refresh-consumed'
}

/**
 * Deep module owning owner-tail profile, prepare state transition, Agent-scoped
 * restriction, neutral surface replacement, cancel/dispose, concurrency, and
 * durable restart/resume. It holds the only in-memory live-state map; callers
 * never read it directly.
 */
export class PersonaTurnDeliveryCoordinator {
  private readonly states = new Map<SessionId, LiveAgentState>()

  /**
   * @param config - RP default, persona path, profile budget, and optional diagnostics.
   * @throws When the profile budget is below the mandatory block size.
   */
  constructor(private readonly config: PersonaTurnDeliveryConfig) {
    if (!Number.isSafeInteger(config.turnVoiceMaxChars)
      || config.turnVoiceMaxChars < MIN_TURN_VOICE_MAX_CHARS) {
      throw new TypeError(`turnVoiceMaxChars must be at least ${MIN_TURN_VOICE_MAX_CHARS}`)
    }
  }

  /**
   * Reconcile one proposed step: recover/validate the prepared final gate,
   * deduplicate its refresh, project exactly one owner-tail profile, and
   * replace stale active profiles with neutral lifecycle records.
   * @param agent - Agent proposing the step.
   * @param turn - Turn owning the step.
   * @param decision - Downstream decision from the pre-step waterfall.
   * @returns The validated decision, possibly with a profile added or stale refreshes removed.
   */
  async beforeStep(agent: Agent, turn: number, decision: PreStepDecision): Promise<PreStepDecision> {
    const state = this.stateFor(agent)
    if (decision.kind === 'reject') {
      this.expireStaleVoices(agent, turn, state)
      return decision
    }

    this.reconcileArmedState(agent, state, decision.messages)
    const messages = this.reconcileRefreshMessages(agent, state, decision.messages)
    const projected = await this.ensureTurnVoice(agent, turn, state, messages)
    this.expireStaleVoices(agent, turn, state)
    return { kind: 'enter', messages: projected }
  }

  /**
   * Install the recovered empty-tool gate synchronously before the first
   * prompt assembly of a running agent when durable facts prove a pending
   * prepared final.
   * @param agent - Agent that just transitioned to `running`.
   */
  onAgentRunning(agent: Agent): void {
    const state = this.stateFor(agent)
    const prepared = this.latestArmedPrepare(agent)
    if (prepared === undefined || state.armed?.turn === prepared.turn) return
    if (!this.prepareStillPending(agent, prepared.turn, [])) return
    const voice = this.findRefreshEvidence(agent, prepared.turn, [])
    if (voice === undefined) return

    let lift: (() => void) | undefined
    try {
      lift = agent.ctx.tools.restrict({ allow: [] })
    } catch (error) {
      this.report(`restart recovery of prepared final refused: ${error instanceof Error ? error.message : String(error)}`)
      return
    }
    this.replaceVisibleVoices(agent, 'turn-voice', 'superseded')
    state.armed = { turn: prepared.turn, voice, liftRestriction: lift }
    void this.proveRecoveredRestriction(agent, state, lift)
  }

  /**
   * Run the finalization tool body. A legal sole call replaces the active
   * initial profile with a neutral superseded record, then queues one logged
   * final-voice-refresh and installs one Agent-scoped empty-tool gate.
   * @param exec - Live DSH tool execution.
   * @returns Canonical prepare outcome. Persona load failures reject with a neutral error.
   */
  async prepare(exec: ToolRunContext): Promise<PrepareResult> {
    const agent = exec.agent
    if (agent === undefined || exec.parent !== undefined || exec.signal.aborted) return { status: 'refused' }
    const step = latestStepStart(agent)
    const assistant = step === undefined ? undefined : assistantForStep(agent, step)
    if (step === undefined || assistant === undefined) return { status: 'refused' }
    const calls = assistant.message.content.filter(block => block.type === 'tool-call')
    if (calls.length !== 1 || calls[0]?.name !== FINAL_REPLY_TOOL) return { status: 'refused' }
    const turn = step.turn

    const state = this.stateFor(agent)
    if (state.armed !== undefined) {
      if (state.armed.turn === turn) return { status: 'duplicate' }
      this.releaseArmed(state)
      this.replaceVisibleVoices(agent, 'final-voice-refresh', 'consumed')
    }
    if (this.hasDurableArmedPrepareForTurn(agent, turn)) return { status: 'duplicate' }

    if (foldRoleplayMode(agent.session.events, this.config.defaultMode) === 'off') {
      return { status: 'roleplay-off' }
    }
    let persona: PersonaDocument
    try {
      persona = await loadPersona(this.config.personaPath)
    } catch (error) {
      this.report(`final-voice refresh refused: ${error instanceof Error ? error.message : String(error)}`)
      throw new Error('Final reply preparation failed: the published persona could not be loaded or validated.')
    }
    const fingerprint = personaFingerprint(persona)
    const mode = foldRoleplayMode(agent.session.events, this.config.defaultMode)
    if (mode === 'off') return { status: 'roleplay-off' }
    const text = renderFinalVoiceRefresh(persona, mode)
    const voice = createVoiceMessage(text, 'final-voice-refresh', turn, fingerprint)

    const lift = await this.restrictForEmptyFinalStep(agent, exec.signal)
    if (lift === undefined) return { status: 'refused' }
    if (exec.signal.aborted) {
      lift()
      return { status: 'refused' }
    }
    this.replaceVisibleVoices(agent, 'turn-voice', 'superseded')
    exec.deferContext(voice)
    state.armed = { turn, voice, liftRestriction: lift }
    return { status: 'armed' }
  }

  /** Normal completion: lift the gate and replace every active profile with neutral lifecycle records. */
  finishTurn(agent: Agent, _turn: number): void {
    const state = this.matchingState(agent)
    if (state !== undefined) this.releaseArmed(state)
    this.replaceVisibleVoices(agent, 'turn-voice', 'consumed')
    this.replaceVisibleVoices(agent, 'final-voice-refresh', 'consumed')
  }

  /** Cancel/error convergence: lift the gate and neutralize active surfaces, idempotently. */
  settle(agent: Agent): void {
    const state = this.matchingState(agent)
    if (state !== undefined) this.releaseArmed(state)
    this.replaceVisibleVoices(agent, 'turn-voice', 'consumed')
    this.replaceVisibleVoices(agent, 'final-voice-refresh', 'consumed')
  }

  /** Agent disposal: lift the gate and neutralize logged profiles before teardown. */
  disposeAgent(agent: Agent): void {
    this.settle(agent)
    this.states.delete(agent.id)
  }

  /** Plugin disposal: release every live gate and neutralize every visible active profile. */
  dispose(): void {
    for (const state of [...this.states.values()]) {
      this.releaseArmed(state)
      this.replaceVisibleVoices(state.agent, 'turn-voice', 'consumed')
      this.replaceVisibleVoices(state.agent, 'final-voice-refresh', 'consumed')
    }
    this.states.clear()
  }

  /** Locate or create live state for one branded agent identity. */
  private stateFor(agent: Agent): LiveAgentState {
    const existing = this.states.get(agent.id)
    if (existing?.agent === agent) return existing
    if (existing !== undefined) this.releaseArmed(existing)
    const created: LiveAgentState = { agent }
    this.states.set(agent.id, created)
    return created
  }

  private matchingState(agent: Agent): LiveAgentState | undefined {
    const state = this.states.get(agent.id)
    return state?.agent === agent ? state : undefined
  }

  private report(message: string): void {
    this.config.report?.(message)
  }

  /** Release one gate; the restriction disposer is idempotent and must not throw into lifecycle dispatch. */
  private releaseArmed(state: LiveAgentState): void {
    const armed = state.armed
    state.armed = undefined
    if (armed === undefined) return
    try {
      armed.liftRestriction()
    } catch (error) {
      this.report(`lifting final-voice restriction failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * Install an Agent-scoped empty-tool restriction and prove, through the
   * official prompt assembly, that the next request would expose no tools.
   * Any inability to prove an empty final step lifts the restriction and fails closed.
   */
  private async restrictForEmptyFinalStep(agent: Agent, signal: AbortSignal): Promise<(() => void) | undefined> {
    let lift: (() => void) | undefined
    try {
      lift = agent.ctx.tools.restrict({ allow: [] })
      const assembly = await agent.ctx.systemPrompt.assemble(assembleContextFor(agent, signal))
      if (assembly.tools.length === 0) return lift
      lift()
      return undefined
    } catch (error) {
      try {
        lift?.()
      } catch {
        // The restriction disposer is idempotent; a second failure changes nothing.
      }
      this.report(`final-voice restriction proof failed: ${error instanceof Error ? error.message : String(error)}`)
      return undefined
    }
  }

  /** Asynchronously prove a synchronously recovered restriction; failure lifts it before later requests. */
  private async proveRecoveredRestriction(agent: Agent, state: LiveAgentState, lift: () => void): Promise<void> {
    try {
      const assembly = await agent.ctx.systemPrompt.assemble(assembleContextFor(agent))
      if (assembly.tools.length === 0) return
    } catch (error) {
      this.report(`recovered final-voice restriction proof failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (state.armed?.liftRestriction === lift) {
      this.releaseArmed(state)
    }
  }

  /** Latest durable successful prepare call/result, if the result cites its call. */
  private latestArmedPrepare(agent: Agent): { turn: number; step: number } | undefined {
    for (let index = agent.session.events.length - 1; index >= 0; index--) {
      const event = agent.session.events[index]
      if (event?.type !== 'tool/result') continue
      const meta = prepareMetaOf(event.data.meta)
      if (meta?.status !== 'armed') continue
      const callSeq = event.sourceEventSeqs?.[0]
      if (callSeq === undefined) continue
      const call = eventAt(agent.session.events, callSeq)
      if (call?.type !== 'tool/call'
        || call.data.name !== FINAL_REPLY_TOOL
        || call.data.turn !== event.data.turn
        || call.data.step !== event.data.step) continue
      return { turn: event.data.turn, step: event.data.step }
    }
    return undefined
  }

  private hasDurableArmedPrepareForTurn(agent: Agent, turn: number): boolean {
    for (let index = agent.session.events.length - 1; index >= 0; index--) {
      const event = agent.session.events[index]
      if (event?.type !== 'tool/result' || event.data.turn !== turn) continue
      const meta = prepareMetaOf(event.data.meta)
      if (meta?.status !== 'armed') continue
      const callSeq = event.sourceEventSeqs?.[0]
      if (callSeq === undefined) continue
      const call = eventAt(agent.session.events, callSeq)
      if (call?.type === 'tool/call'
        && call.data.name === FINAL_REPLY_TOOL
        && call.data.turn === turn
        && call.data.step === event.data.step) return true
    }
    return false
  }

  /** Whether the assistant for a prepared turn already delivered its owner-facing final. */
  private hasDeliveredFinal(agent: Agent, turn: number): boolean {
    for (let index = agent.session.events.length - 1; index >= 0; index--) {
      const event = agent.session.events[index]
      if (event?.type !== 'assistant/message' || event.data.turn !== turn) continue
      return event.data.message.content.every(block => block.type !== 'tool-call')
    }
    return false
  }

  /** How a prepared turn ended, when its durable boundary already exists. */
  private turnEnding(agent: Agent, turn: number): 'closed' | 'interrupted' | undefined {
    for (let index = agent.session.events.length - 1; index >= 0; index--) {
      const event = agent.session.events[index]
      if (event?.type !== 'turn/end' || event.data.turn !== turn) continue
      return event.data.reason.kind === 'interrupted' ? 'interrupted' : 'closed'
    }
    return undefined
  }

  /** One pending prepared final still needs its tool-free request. */
  private prepareStillPending(agent: Agent, turn: number, messages: readonly UserMessage[]): boolean {
    if (this.hasDeliveredFinal(agent, turn)) return false
    if (this.turnEnding(agent, turn) === 'closed') return false
    return this.findRefreshEvidence(agent, turn, messages) !== undefined
  }

  /** Locate the exact refresh message from visible history, pending inbox, or the claimed step batch. */
  private findRefreshEvidence(agent: Agent, turn: number, messages: readonly UserMessage[]): UserMessage | undefined {
    const visible = this.visibleVoiceEvent(agent, 'final-voice-refresh', turn)
    if (visible !== undefined) return visible.data
    for (const message of agent.inbox.nextStep) {
      if (isFinalRefreshMessage(message, turn)) return message
    }
    for (const message of messages) {
      if (isFinalRefreshMessage(message, turn)) return message
    }
    return undefined
  }

  /**
   * Keep or release the live prepared gate against durable facts. A gate that
   * lost its refresh evidence is released and its profiles neutralized before
   * the request, never after.
   */
  private reconcileArmedState(agent: Agent, state: LiveAgentState, messages: readonly UserMessage[]): void {
    if (state.armed === undefined) return
    this.replaceVisibleVoices(agent, 'turn-voice', 'superseded')
    const prepared = this.latestArmedPrepare(agent)
    if (prepared?.turn !== state.armed.turn
      || !this.prepareStillPending(agent, state.armed.turn, messages)) {
      this.releaseArmed(state)
      this.replaceVisibleVoices(agent, 'final-voice-refresh', 'consumed')
    }
  }

  /**
   * Enforce exactly-once refresh delivery. An already-visible refresh is never
   * appended again; without an armed gate, pending refreshes are dropped so
   * persona text never accompanies business tools.
   */
  private reconcileRefreshMessages(agent: Agent, state: LiveAgentState, messages: readonly UserMessage[]): UserMessage[] {
    const visible = state.armed === undefined
      ? undefined
      : this.visibleVoiceEvent(agent, 'final-voice-refresh', state.armed.turn)
    if (visible !== undefined) {
      return messages.filter(message => !isFinalRefreshMessage(message, state.armed!.turn))
    }
    const indexes = messages
      .map((message, index) => ({ message, index }))
      .filter(entry => isFinalRefreshMessage(entry.message))
      .map(entry => entry.index)
    if (state.armed === undefined) {
      return messages.filter((_, index) => !indexes.includes(index))
    }
    if (indexes.length === 0) {
      this.releaseArmed(state)
      return [...messages]
    }
    if (indexes.length === 1) return [...messages]
    const keep = indexes[0] ?? 0
    return messages.filter((_, index) => index === keep || !indexes.includes(index))
  }

  /**
   * Project exactly one bounded owner-turn profile after the first real owner
   * message of an active RP turn. Replays, retries, and later steps reuse the
   * same durable profile; load failures fail open for Coding.
   */
  private async ensureTurnVoice(
    agent: Agent,
    turn: number,
    state: LiveAgentState,
    messages: readonly UserMessage[],
  ): Promise<UserMessage[]> {
    if (state.capsuleTurn === turn) return [...messages]
    if (this.rawVoiceEvent(agent, 'turn-voice', turn) !== undefined) {
      state.capsuleTurn = turn
      return [...messages]
    }
    const ownerIndex = messages.findIndex(message => message.source.kind === 'user')
    if (ownerIndex < 0) return [...messages]
    const mode = foldRoleplayMode(agent.session.events, this.config.defaultMode)
    if (mode === 'off') {
      state.capsuleTurn = turn
      return [...messages]
    }
    let persona: PersonaDocument
    try {
      persona = await loadPersona(this.config.personaPath)
    } catch (error) {
      this.report(`turn-voice projection skipped for a Coding-safe turn: ${error instanceof Error ? error.message : String(error)}`)
      state.capsuleTurn = turn
      return [...messages]
    }
    const text = renderTurnVoice(persona, this.config.turnVoiceMaxChars)
    const voice = createVoiceMessage(text, 'turn-voice', turn, personaFingerprint(persona))
    state.capsuleTurn = turn
    return [...messages.slice(0, ownerIndex + 1), voice, ...messages.slice(ownerIndex + 1)]
  }

  /** Replace stale active profiles that must not survive into the next owner request. */
  private expireStaleVoices(agent: Agent, currentTurn: number, state: LiveAgentState): void {
    const nodes = [...agent.session.surface.nodes]
    for (let index = nodes.length - 1; index >= 0; index--) {
      const seq = nodes[index]
      if (seq === undefined) continue
      const event = eventAt(agent.session.events, seq)
      if (event?.type !== 'user/message') continue
      const projection = voiceProjectionOf(event.data.source)
      if (!isActiveVoiceProjection(projection)) continue
      const sourceTurn = voiceTurnOf(event.data.source)
      if (projection === 'turn-voice' && sourceTurn !== undefined && sourceTurn < currentTurn) {
        this.replaceVoiceSurface(agent, event.seq, 'turn-voice', 'consumed', sourceTurn)
      } else if (projection === 'final-voice-refresh' && sourceTurn !== state.armed?.turn) {
        this.replaceVoiceSurface(agent, event.seq, 'final-voice-refresh', 'consumed', sourceTurn ?? currentTurn)
      }
    }
  }

  /** Replace every currently visible active profile with its neutral lifecycle record. */
  private replaceVisibleVoices(agent: Agent, projection: VoiceProjection, reason: 'consumed' | 'superseded'): void {
    const nodes = [...agent.session.surface.nodes]
    for (let index = nodes.length - 1; index >= 0; index--) {
      const seq = nodes[index]
      if (seq === undefined) continue
      const event = eventAt(agent.session.events, seq)
      if (event?.type !== 'user/message') continue
      const sourceProjection = voiceProjectionOf(event.data.source)
      if (sourceProjection !== projection || !isActiveVoiceProjection(sourceProjection)) continue
      this.replaceVoiceSurface(agent, event.seq, sourceProjection, reason, voiceTurnOf(event.data.source) ?? 0)
    }
  }

  /** Replace one exact visible active voice surface entry with its neutral lifecycle record. */
  private replaceVoiceSurface(
    agent: Agent,
    seq: number,
    projection: VoiceProjection,
    reason: 'consumed' | 'superseded',
    turn: number,
  ): void {
    const replacementProjection = replacementFor(projection, reason)
    const marker = createVoiceMessage(lifecycleText(replacementProjection), replacementProjection, turn)
    try {
      agent.session.append('user/message', marker, {
        surfaceOp: { op: 'replace', start: seq, end: seq },
        sourceEventSeqs: [seq],
      })
    } catch (error) {
      this.report(`voice surface replacement failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** Current surface event carrying one projection for one turn. */
  private visibleVoiceEvent(
    agent: Agent,
    projection: VoiceProjection,
    turn: number,
  ): SessionEvent<'user/message'> | undefined {
    for (let index = agent.session.surface.nodes.length - 1; index >= 0; index--) {
      const seq = agent.session.surface.nodes[index]
      if (seq === undefined) continue
      const event = eventAt(agent.session.events, seq)
      if (event?.type !== 'user/message') continue
      if (voiceProjectionOf(event.data.source) !== projection) continue
      if (voiceTurnOf(event.data.source) === turn) return event
    }
    return undefined
  }

  /** Any raw event carrying one projection for one turn, regardless of surface state. */
  private rawVoiceEvent(
    agent: Agent,
    projection: VoiceProjection,
    turn: number,
  ): SessionEvent<'user/message'> | undefined {
    for (const event of agent.session.events) {
      if (event.type !== 'user/message') continue
      if (voiceProjectionOf(event.data.source) !== projection) continue
      if (voiceTurnOf(event.data.source) === turn) return event
    }
    return undefined
  }
}

/**
 * Build the registered finalization tool. Schema, output, and UI metadata
 * never contain persona identity, relationship, tone, or voice examples.
 * @param coordinator - The owning two-phase delivery state machine.
 * @returns Official DSH tool definition.
 */
export function finalReplyTool(coordinator: PersonaTurnDeliveryCoordinator): ToolDefinition {
  return defineTool({
    name: FINAL_REPLY_TOOL,
    description: 'Call this tool exactly once, as the only tool call in your response, after all work is complete '
      + 'and your next assistant output should be delivered directly to the owner as the final reply. '
      + 'It prepares a final reply step with no tools available.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: {
            type: 'string',
            required: true,
            enum: ['armed', 'roleplay-off', 'duplicate', 'refused'],
          },
        },
      },
      render: (_args, result) => [{
        type: 'text',
        text: PREPARE_RENDER[result.status as PrepareStatus] ?? PREPARE_RENDER.refused,
      }],
      presentationMeta: (_args, value) => {
        const status = (value as { status?: unknown }).status
        return {
          kind: 'mistymoon-prepare',
          status: status === 'armed' || status === 'roleplay-off' || status === 'duplicate' || status === 'refused'
            ? status
            : 'refused',
        }
      },
    },
    execute: (_args, exec) => coordinator.prepare(exec),
    presentCall: () => ({ card: 'generic', title: 'Prepare final reply', kind: 'edit', rawInput: {} }),
  })
}
