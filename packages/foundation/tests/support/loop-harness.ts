import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentRegistry, { assembleContextFor } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { createUserMessage, type GenerateOptions } from '@deepseek-ai/dsh-llm'
import SessionStore, { Session, SessionId, foldRequestHeader, type SessionEvent } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import * as IdentityPlugin from '@mistymoon/dsh-identity'
import { expect } from 'vitest'
import * as FoundationPlugin from '../../src/index.js'
import type { PersonaDocument } from '../../src/index.js'
import {
  FINAL_VOICE_REFRESH_CONSUMED_SECTION,
  FINAL_VOICE_REFRESH_SECTION,
  TURN_VOICE_CONSUMED_SECTION,
  TURN_VOICE_SECTION,
  TURN_VOICE_SUPERSEDED_SECTION,
  VOICE_FORM,
  VOICE_PLUGIN,
  voiceProjectionOf,
} from '../../src/index.js'
import { ScriptedAdapter } from './mock-llm.js'

export const PRESET_PERSONA = 'Neutral preset persona.'
export const COMPLETE_PROMPT = 'Exact coding prompt.'

/** Neutral generated persona written into every temporary Foundation home. */
export const NEUTRAL_PERSONA: PersonaDocument = {
  schemaVersion: 2,
  kind: 'mistymoon.persona',
  displayName: 'Luna',
  identity: {
    summary: 'A steady companion who values precise recollection.',
    relationship: 'Continue shared work without inventing shared history.',
    familiarRelationship: 'Refer only to shared, disclosable work.',
    strangerRelationship: 'Be polite without assuming familiarity.',
  },
  style: {
    tone: ['warm', 'plain-spoken'],
    instructions: 'Keep casual chat concise and technical work complete.',
    avoid: ['false certainty'],
  },
  advancedInstructions: 'Admit uncertainty directly.',
  referenceDialogs: [{ user: 'Are you sure?', assistant: 'Not yet. I should verify it.' }],
  responseBudgets: {
    brief: { targetCharacters: 40, maxOutputTokens: 100 },
    normal: { targetCharacters: 200, maxOutputTokens: 500 },
    deep: { targetCharacters: 800, maxOutputTokens: 1600 },
  },
  boundaries: {
    privateByDefault: true,
    requireApprovalForExternalActions: true,
  },
}

export interface LoopHarness {
  ctx: Context
  adapter: ScriptedAdapter
  home: string
  foundationFiber?: { dispose(): Promise<void> }
}

export async function loopHarness(
  adapter: ScriptedAdapter,
  options: { foundation?: boolean; complete?: boolean; retryOnce?: boolean } = {},
): Promise<LoopHarness> {
  const home = await mkdtemp(join(tmpdir(), 'mistymoon-agent-loop-'))
  await mkdir(join(home, 'persona'), { recursive: true })
  await writeFile(join(home, 'persona', 'persona.json'), `${JSON.stringify(NEUTRAL_PERSONA)}\n`, 'utf8')
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, { includeHarnessIdentity: true, persona: PRESET_PERSONA })
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(IdentityPlugin, { ownerId: 'owner-fixture' })
  ctx.llm.registerAdapter(['mock'], adapter)
  ctx.tools.register(defineContentToolFixture({
    name: 'echo',
    description: 'Echo the given text.',
    parameters: { text: { type: 'string', required: true } },
    async execute(args) {
      return [{ type: 'text', text: `echo: ${String(args.text)}` }]
    },
  }))
  if (options.complete === true) {
    ctx.systemPrompt.section({ name: 'preset:minimal', order: 10, text: COMPLETE_PROMPT, complete: true })
  }
  if (options.retryOnce === true) {
    let retried = false
    ctx.on('agent/request-error', async (payload, next) => {
      const action = await next()
      if (action?.kind === 'retry' || retried || payload.turn < 1) return action
      retried = true
      return { kind: 'retry' as const }
    })
  }
  const foundationFiber = options.foundation === false ? undefined : await ctx.plugin(FoundationPlugin, { home, defaultRoleplayMode: 'companion' })
  return { ctx, adapter, home, foundationFiber }
}

export function waitForIdle(ctx: Context, agent: Agent): Promise<void> {
  return new Promise((resolve) => {
    const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject === agent && status === 'idle') {
        dispose()
        resolve()
      }
    })
  })
}

export function send(agent: Agent, text: string): void {
  agent.followup(createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user', rpcId: `rpc-${text}` } as ReturnType<typeof createUserMessage>['source'],
  }))
}

/** Durable user/message events carrying one voice projection. */
export function projectionEvents(events: readonly SessionEvent[], projection: string): SessionEvent[] {
  return events.filter(event => event.type === 'user/message' && voiceProjectionOf(event.data.source) === projection)
}

/** Durable user/message events carrying the owner-tail capsule. */
export function turnVoiceEvents(events: readonly SessionEvent[]): SessionEvent[] {
  return projectionEvents(events, 'turn-voice')
}

/** Durable user/message events carrying the prepared final refresh. */
export function finalVoiceRefreshEvents(events: readonly SessionEvent[]): SessionEvent[] {
  return projectionEvents(events, 'final-voice-refresh')
}

/** Durable user/message events carrying either neutral lifecycle record. */
export function lifecycleRecordEvents(events: readonly SessionEvent[]): SessionEvent[] {
  return [
    ...projectionEvents(events, 'turn-voice-consumed'),
    ...projectionEvents(events, 'turn-voice-superseded'),
    ...projectionEvents(events, 'final-voice-refresh-consumed'),
  ]
}

/** Whether one durable event carries a named section. */
export function hasSection(event: SessionEvent, section: string): boolean {
  if (event.type !== 'user/message' || event.data.source.kind !== 'mistymoon-voice') return false
  return event.data.source.sections.some(entry => entry.name === section)
}

export const VOICE_SOURCE = { plugin: VOICE_PLUGIN, form: VOICE_FORM }
export const TURN_VOICE = { section: TURN_VOICE_SECTION, consumed: TURN_VOICE_CONSUMED_SECTION, superseded: TURN_VOICE_SUPERSEDED_SECTION }
export const FINAL_VOICE_REFRESH = { section: FINAL_VOICE_REFRESH_SECTION, consumed: FINAL_VOICE_REFRESH_CONSUMED_SECTION }

/** Effective model-visible tools for one agent, through the official assembly seam. */
export async function agentTools(agent: Agent): Promise<string[]> {
  const assembly = await agent.ctx.systemPrompt.assemble(assembleContextFor(agent))
  return assembly.tools.map(tool => tool.name)
}

/** Rebuild the exact model request from the durable log prefix, as the DSH loop theorem does. */
export function assertReconstructable(events: readonly SessionEvent[], index: number, request: GenerateOptions): void {
  const stepStarts = events.filter(event => event.type === 'step/start')
  const start = stepStarts[index]
  if (start?.type !== 'step/start') throw new Error(`missing step/start ${index}`)
  const firstChunk = events.find(event =>
    event.type === 'assistant/chunk'
    && event.data.turn === start.data.turn
    && event.data.step === start.data.step)
  if (firstChunk?.type !== 'assistant/chunk') throw new Error(`missing first chunk for request ${index}`)
  const prefix = events.slice(0, firstChunk.seq)
  const rebuilt = Session.create(SessionId(`rebuilt-${index}`), structuredClone(prefix))
  expect(structuredClone(request.messages)).toEqual(rebuilt.deriveMessages())
  const header = foldRequestHeader(prefix)
  expect(header?.system).toBe(request.system)
  expect(structuredClone(header?.tools ?? [])).toEqual(structuredClone(request.tools ?? []))
}
