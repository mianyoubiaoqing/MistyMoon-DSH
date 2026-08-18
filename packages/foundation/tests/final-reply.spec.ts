import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { assembleContextFor, type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, {
  CallId,
  createAssistantMessage,
  createToolResultMessage,
  createUserMessage,
  type UserMessage,
} from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, SessionPreparation, type Session } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineContentToolFixture, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { DshOwnerEligibilityService } from '@mistymoon/dsh-identity'
import * as IdentityPlugin from '@mistymoon/dsh-identity'
import { describe, expect, it } from 'vitest'
import * as FoundationPlugin from '../src/index.js'
import {
  DEFAULT_TURN_VOICE_MAX_CHARS,
  FINAL_REPLY_TOOL,
  FINAL_VOICE_REFRESH_CONSUMED_SECTION,
  FINAL_VOICE_REFRESH_SECTION,
  MIN_TURN_VOICE_MAX_CHARS,
  PersonaTurnDeliveryCoordinator,
  renderFinalVoiceRefresh,
  renderTurnVoice,
  renderTurnVoiceSuperseded,
  TURN_VOICE_CONSUMED_SECTION,
  TURN_VOICE_SECTION,
  TURN_VOICE_SUPERSEDED_SECTION,
  voiceProjectionOf,
  type PersonaDocument,
  type VoiceProjection,
} from '../src/index.js'
import { ScriptedAdapter, textResponse } from './support/mock-llm.js'

const NEUTRAL_PERSONA: PersonaDocument = {
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

async function writePersona(root: string, persona: PersonaDocument = NEUTRAL_PERSONA): Promise<string> {
  const path = join(root, 'persona.json')
  await writeFile(path, `${JSON.stringify(persona)}\n`, 'utf8')
  return path
}

function ownerEligibility(): DshOwnerEligibilityService {
  return new DshOwnerEligibilityService({ ownerId: 'owner-fixture' })
}

async function coordinatorHarness(persona: PersonaDocument = NEUTRAL_PERSONA, defaultMode: 'companion' | 'immersive' = 'companion') {
  const home = await mkdtemp(join(tmpdir(), 'mistymoon-turn-delivery-'))
  const personaPath = await writePersona(home, persona)
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, { includeHarnessIdentity: true, persona: 'Neutral preset persona.' })
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.tools.register(defineContentToolFixture({
    name: 'echo',
    description: 'Echo the given text.',
    parameters: { text: { type: 'string', required: true } },
    async execute(args) {
      return [{ type: 'text', text: `echo: ${String(args.text)}` }]
    },
  }))
  const agent = ctx.agentLoop.create(SessionId(`coordinator-${crypto.randomUUID()}`), { provider: 'mock', model: 'mock' })
  const coordinator = new PersonaTurnDeliveryCoordinator({
    ownerEligibility: ownerEligibility(),
    defaultMode,
    personaPath,
    turnVoiceMaxChars: DEFAULT_TURN_VOICE_MAX_CHARS,
  })
  return { ctx, home, personaPath, agent, coordinator }
}

function ownerMessage(text: string): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user', rpcId: `rpc-${text}` } as UserMessage['source'],
  })
}

function ensureTurnStarted(agent: Agent, turn: number): void {
  const active = [...agent.session.events].reverse().find(event =>
    event.type === 'turn/start' || event.type === 'turn/end')
  if (active?.type === 'turn/start' && active.data.turn === turn) return
  agent.session.append('turn/start', { turn })
}

function appendStepWithCalls(agent: Agent, turn: number, step: number, calls: readonly { rawId: string; name: string }[]): void {
  ensureTurnStarted(agent, turn)
  const hasOwner = agent.session.events.some(event => event.type === 'user/message'
    && event.data.source.kind === 'user'
    && 'rpcId' in event.data.source)
  if (!hasOwner) {
    agent.session.append('user/message', ownerMessage(`tool-owner-${turn}`), { surfaceOp: 'append' })
  }
  agent.session.append('step/start', { turn, step })
  agent.session.append('assistant/message', {
    turn,
    step,
    message: createAssistantMessage({
      content: calls.map(call => ({
        type: 'tool-call' as const,
        id: CallId(call.rawId),
        name: call.name,
        arguments: '{}',
      })),
      source: { provider: 'mock', model: 'mock' },
    }),
  }, { surfaceOp: 'append', sourceEventSeqs: [] })
}

interface PreparedCall {
  exec: ToolRunContext
  deferred: UserMessage[]
}

function prepareCall(agent: Agent, options: { aborted?: boolean; parent?: boolean } = {}): PreparedCall {
  const deferred: UserMessage[] = []
  const controller = new AbortController()
  if (options.aborted === true) controller.abort(new Error('aborted'))
  const exec = {
    agent,
    parent: options.parent === true ? {} : undefined,
    signal: controller.signal,
    deferContext(context: UserMessage) {
      deferred.push(context)
    },
    concludeTurn() {},
  } as unknown as ToolRunContext
  return { exec, deferred }
}

async function agentToolNames(agent: Agent): Promise<string[]> {
  const assembly = await agent.ctx.systemPrompt.assemble(assembleContextFor(agent))
  return assembly.tools.map(tool => tool.name)
}

function commitArmedPrepareResult(agent: Agent, turn: number, step: number, callId: string): void {
  const id = CallId(callId)
  const toolCall = agent.session.append('tool/call', { turn, step, callId: id, name: FINAL_REPLY_TOOL, arguments: '{}' })
  agent.session.append('tool/result', {
    turn,
    step,
    message: createToolResultMessage({
      callId: id,
      content: [{ type: 'text', text: 'Final reply prepared: the next assistant output is the owner-facing final reply, with no tools available.' }],
      isError: false,
    }),
    meta: { kind: 'mistymoon-prepare', status: 'armed' },
  }, { surfaceOp: 'append', sourceEventSeqs: [toolCall.seq] })
}

async function arm(coordinator: PersonaTurnDeliveryCoordinator, agent: Agent, turn = 1, step = 1): Promise<PreparedCall> {
  appendStepWithCalls(agent, turn, step, [{ rawId: 'prepare', name: FINAL_REPLY_TOOL }])
  const call = prepareCall(agent)
  const result = await coordinator.prepare(call.exec)
  expect(result).toEqual({ status: 'armed' })
  commitArmedPrepareResult(agent, turn, step, 'prepare')
  return call
}

function appendMessages(agent: Agent, turn: number, step: number, messages: readonly UserMessage[]): void {
  ensureTurnStarted(agent, turn)
  agent.session.append('step/start', { turn, step })
  for (const message of messages) {
    agent.session.append('user/message', message, { surfaceOp: 'append' })
  }
  agent.session.append('step/end', { turn, step })
}

async function projectOwnerTurn(
  coordinator: PersonaTurnDeliveryCoordinator,
  agent: Agent,
  turn = 1,
  text = 'Neutral owner message.',
): Promise<readonly UserMessage[]> {
  const decision = await coordinator.beforeStep(agent, turn, { kind: 'enter', messages: [ownerMessage(text)] })
  expect(decision.kind).toBe('enter')
  if (decision.kind !== 'enter') throw new Error('unreachable')
  appendMessages(agent, turn, 1, decision.messages)
  return decision.messages
}

function eventsWithProjection(agent: Agent, projection: VoiceProjection): number {
  return agent.session.events.filter(event => event.type === 'user/message'
    && voiceProjectionOf(event.data.source) === projection).length
}

function currentProjectionCount(agent: Agent, projection: VoiceProjection): number {
  return agent.session.deriveMessages().filter(message => voiceProjectionOf(message.source) === projection).length
}

describe('PersonaTurnDeliveryCoordinator', () => {
  it('rejects an invalid capsule budget at construction', () => {
    expect(() => new PersonaTurnDeliveryCoordinator({
      ownerEligibility: ownerEligibility(),
      defaultMode: 'companion',
      personaPath: join(tmpdir(), 'unused.json'),
      turnVoiceMaxChars: MIN_TURN_VOICE_MAX_CHARS - 1,
    })).toThrow(/at least/)
  })

  it('projects one bounded companion owner-tail capsule with non-private source identity', async () => {
    const { agent, coordinator } = await coordinatorHarness()
    const messages = await projectOwnerTurn(coordinator, agent)

    expect(messages).toHaveLength(2)
    const voice = messages[1]
    if (voice === undefined) throw new Error('missing voice')
    const text = voice.content.map(block => block.type === 'text' ? block.text : '').join('')
    expect(text).toContain('MistyMoon output presentation profile')
    expect(text).toContain('Speaker label: Luna.')
    expect(text).not.toContain('Example 1 Luna:')
    expect(text).not.toContain('Companion identity')
    expect(text.length).toBeLessThanOrEqual(DEFAULT_TURN_VOICE_MAX_CHARS)
    expect(voice.source).toMatchObject({
      kind: 'mistymoon-voice',
      plugin: 'mistymoon-foundation',
      form: 'snapshot',
      projection: 'turn-voice',
      turn: 1,
      personaVersion: 2,
    })
    if (voice.source.kind !== 'mistymoon-voice') throw new Error('unexpected source')
    expect(voice.source.personaHash).toMatch(/^[0-9a-f]{64}$/)
    expect(voice.source.sections.map(section => section.name)).toEqual([TURN_VOICE_SECTION])
    expect(voice.source.estimatedTokens).toBeGreaterThan(0)
    expect(eventsWithProjection(agent, 'turn-voice')).toBe(1)

    // Later pre-steps and a fresh HMR-era coordinator reuse the logged capsule.
    const repeated = await coordinator.beforeStep(agent, 1, { kind: 'enter', messages: [ownerMessage('later owner?')] })
    expect(repeated.kind).toBe('enter')
    if (repeated.kind !== 'enter') throw new Error('unreachable')
    expect(repeated.messages).toHaveLength(1)
    const replacement = new PersonaTurnDeliveryCoordinator({
      ownerEligibility: ownerEligibility(),
      defaultMode: 'companion',
      personaPath: (await coordinatorHarness()).personaPath,
      turnVoiceMaxChars: DEFAULT_TURN_VOICE_MAX_CHARS,
    })
    const replayed = await replacement.beforeStep(agent, 1, { kind: 'enter', messages: [ownerMessage('replayed owner?')] })
    expect(replayed.kind).toBe('enter')
    if (replayed.kind !== 'enter') throw new Error('unreachable')
    expect(replayed.messages).toHaveLength(1)
    expect(eventsWithProjection(agent, 'turn-voice')).toBe(1)
  })

  it('does not project Persona into a depth-one child prompt shaped as user input', async () => {
    const { ctx, coordinator } = await coordinatorHarness()
    const handle = await ctx.agents.create({
      sessionId: SessionId(`coordinator-child-${crypto.randomUUID()}`),
      meta: { origin: 'subagent', delegationDepth: 1 },
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    const childPrompt = createUserMessage({
      content: [{ type: 'text', text: 'Delegated coding task.' }],
      source: { kind: 'user', rpcId: 'rpc-shape-is-not-enough' } as UserMessage['source'],
    })

    const decision = await coordinator.beforeStep(handle.agent, 1, {
      kind: 'enter',
      messages: [childPrompt],
    })

    expect(decision).toEqual({ kind: 'enter', messages: [childPrompt] })
    if (decision.kind !== 'enter') throw new Error('unreachable')
    expect(eventsWithProjection(handle.agent, 'turn-voice')).toBe(0)
    appendMessages(handle.agent, 1, 1, decision.messages)
    appendStepWithCalls(handle.agent, 1, 2, [{ rawId: 'child-prepare', name: FINAL_REPLY_TOOL }])
    const prepare = prepareCall(handle.agent)
    expect(await coordinator.prepare(prepare.exec)).toEqual({ status: 'refused' })
    expect(prepare.deferred).toEqual([])
    expect(eventsWithProjection(handle.agent, 'final-voice-refresh')).toBe(0)
    await handle.dispose()
  })

  it('keeps the immersive initial capsule small and reserves full reference dialog for the refresh', async () => {
    const { agent, coordinator } = await coordinatorHarness(NEUTRAL_PERSONA, 'immersive')
    const messages = await projectOwnerTurn(coordinator, agent)
    const capsule = messages[1]!.content.map(block => block.type === 'text' ? block.text : '').join('')
    expect(capsule).not.toContain('Example 1 Luna:')
    expect(capsule).not.toContain('Companion identity')
    expect(capsule.length).toBeLessThanOrEqual(DEFAULT_TURN_VOICE_MAX_CHARS)

    const call = await arm(coordinator, agent)
    const voice = call.deferred[0]
    if (voice === undefined) throw new Error('missing refresh')
    const text = voice.content.map(block => block.type === 'text' ? block.text : '').join('')
    expect(text).toContain('MistyMoon final-voice-refresh context.')
    expect(text).toContain('Example 1 Luna: Not yet. I should verify it.')
    coordinator.settle(agent)
  })

  it('off never reads the persona, projects, or registers a refresh gate', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mistymoon-turn-delivery-off-'))
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SystemPrompt, { includeHarnessIdentity: true, persona: 'Neutral preset persona.' })
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentLoop, { agents: [] })
    const agent = ctx.agentLoop.create(SessionId(`coordinator-off-${crypto.randomUUID()}`), { provider: 'mock', model: 'mock' })
    const coordinator = new PersonaTurnDeliveryCoordinator({
      ownerEligibility: ownerEligibility(),
      defaultMode: 'off',
      personaPath: join(home, 'persona-does-not-exist.json'),
      turnVoiceMaxChars: DEFAULT_TURN_VOICE_MAX_CHARS,
    })

    const decision = await coordinator.beforeStep(agent, 1, { kind: 'enter', messages: [ownerMessage('Off owner message.')] })
    expect(decision.kind).toBe('enter')
    if (decision.kind !== 'enter') throw new Error('unreachable')
    expect(decision.messages).toHaveLength(1)
    appendStepWithCalls(agent, 1, 1, [{ rawId: 'off-prepare', name: FINAL_REPLY_TOOL }])
    expect(await coordinator.prepare(prepareCall(agent).exec)).toEqual({ status: 'roleplay-off' })
    expect(await agentToolNames(agent)).toEqual([])
    expect(eventsWithProjection(agent, 'turn-voice')).toBe(0)
    expect(eventsWithProjection(agent, 'final-voice-refresh')).toBe(0)
  })

  it('fails open for Coding when the turn capsule cannot be loaded', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mistymoon-turn-delivery-missing-'))
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SystemPrompt, { includeHarnessIdentity: true, persona: 'Neutral preset persona.' })
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentLoop, { agents: [] })
    ctx.tools.register(defineContentToolFixture({
      name: 'echo',
      description: 'Echo the given text.',
      parameters: { text: { type: 'string', required: true } },
      async execute(args) {
        return [{ type: 'text', text: `echo: ${String(args.text)}` }]
      },
    }))
    const agent = ctx.agentLoop.create(SessionId(`coordinator-missing-${crypto.randomUUID()}`), { provider: 'mock', model: 'mock' })
    const coordinator = new PersonaTurnDeliveryCoordinator({
      ownerEligibility: ownerEligibility(),
      defaultMode: 'companion',
      personaPath: join(home, 'persona-missing.json'),
      turnVoiceMaxChars: DEFAULT_TURN_VOICE_MAX_CHARS,
    })

    const decision = await coordinator.beforeStep(agent, 1, { kind: 'enter', messages: [ownerMessage('Coding must continue.')] })
    expect(decision.kind).toBe('enter')
    if (decision.kind !== 'enter') throw new Error('unreachable')
    expect(decision.messages).toHaveLength(1)
    expect(eventsWithProjection(agent, 'turn-voice')).toBe(0)
    expect((await agentToolNames(agent)).sort()).toEqual(['echo'])
  })

  it('arms a sole companion prepare with one refresh and a provably empty final step', async () => {
    const { agent, coordinator } = await coordinatorHarness()
    const call = await arm(coordinator, agent)

    expect(call.deferred).toHaveLength(1)
    const voice = call.deferred[0]
    if (voice === undefined) throw new Error('missing voice')
    expect(voice.source).toMatchObject({ kind: 'mistymoon-voice', plugin: 'mistymoon-foundation', form: 'snapshot', projection: 'final-voice-refresh' })
    if (voice.source.kind !== 'mistymoon-voice') throw new Error('unexpected source')
    expect(voice.source.sections.map(section => section.name)).toEqual([FINAL_VOICE_REFRESH_SECTION])
    expect(voice.source.personaVersion).toBe(2)
    expect(voice.source.personaHash).toMatch(/^[0-9a-f]{64}$/)
    expect(await agentToolNames(agent)).toEqual([])

    const decision = await coordinator.beforeStep(agent, 1, { kind: 'enter', messages: [voice] })
    expect(decision.kind).toBe('enter')
    if (decision.kind !== 'enter') throw new Error('unreachable')
    expect(decision.messages).toHaveLength(1)
    appendMessages(agent, 1, 2, decision.messages)
    coordinator.finishTurn(agent, 1)

    expect((await agentToolNames(agent)).sort()).toEqual(['echo'])
    expect(eventsWithProjection(agent, 'final-voice-refresh')).toBe(1)
    expect(eventsWithProjection(agent, 'final-voice-refresh-consumed')).toBe(1)
    expect(currentProjectionCount(agent, 'final-voice-refresh')).toBe(0)
    expect(agent.session.deriveMessages().some(message => message.content.some(block =>
      block.type === 'text' && block.text.includes('Luna')))).toBe(false)
  })

  it('refuses sibling, aborted, missing-agent, and nested prepares without half-arming', async () => {
    const { agent, coordinator } = await coordinatorHarness()
    appendStepWithCalls(agent, 1, 1, [
      { rawId: 'echo-call', name: 'echo' },
      { rawId: 'prepare', name: FINAL_REPLY_TOOL },
    ])
    expect(await coordinator.prepare(prepareCall(agent).exec)).toEqual({ status: 'refused' })
    expect((await agentToolNames(agent).then(names => names.sort()))).toEqual(['echo'])

    appendStepWithCalls(agent, 1, 2, [{ rawId: 'prepare', name: FINAL_REPLY_TOOL }])
    expect(await coordinator.prepare(prepareCall(agent, { aborted: true }).exec)).toEqual({ status: 'refused' })
    expect(await coordinator.prepare(prepareCall(agent, { parent: true }).exec)).toEqual({ status: 'refused' })
    const noAgent = prepareCall(agent)
    ;(noAgent.exec as { agent?: unknown }).agent = undefined
    expect(await coordinator.prepare(noAgent.exec)).toEqual({ status: 'refused' })
    expect((await agentToolNames(agent).then(names => names.sort()))).toEqual(['echo'])
  })

  it('reports duplicate prepares for one turn without adding a second refresh', async () => {
    const { agent, coordinator } = await coordinatorHarness()
    const first = await arm(coordinator, agent, 1, 1)
    appendStepWithCalls(agent, 1, 2, [{ rawId: 'prepare-2', name: FINAL_REPLY_TOOL }])
    const duplicate = prepareCall(agent)

    expect(await coordinator.prepare(duplicate.exec)).toEqual({ status: 'duplicate' })
    expect(first.deferred).toHaveLength(1)
    expect(duplicate.deferred).toHaveLength(0)
    expect(await agentToolNames(agent)).toEqual([])
    coordinator.settle(agent)
  })

  it('rejects persona load failures for prepare without arming or falling back', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mistymoon-turn-delivery-invalid-'))
    const personaPath = join(home, 'persona.json')
    await writeFile(personaPath, '{"schemaVersion":2,"kind":"mistymoon.persona"}\n', 'utf8')
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SystemPrompt, { includeHarnessIdentity: true, persona: 'Neutral preset persona.' })
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentLoop, { agents: [] })
    ctx.tools.register(defineContentToolFixture({
      name: 'echo',
      description: 'Echo the given text.',
      parameters: { text: { type: 'string', required: true } },
      async execute(args) {
        return [{ type: 'text', text: `echo: ${String(args.text)}` }]
      },
    }))
    const agent = ctx.agentLoop.create(SessionId(`coordinator-invalid-${crypto.randomUUID()}`), { provider: 'mock', model: 'mock' })
    appendStepWithCalls(agent, 1, 1, [{ rawId: 'prepare', name: FINAL_REPLY_TOOL }])
    const coordinator = new PersonaTurnDeliveryCoordinator({
      ownerEligibility: ownerEligibility(),
      defaultMode: 'companion',
      personaPath,
      turnVoiceMaxChars: DEFAULT_TURN_VOICE_MAX_CHARS,
    })
    const call = prepareCall(agent)

    await expect(coordinator.prepare(call.exec)).rejects.toThrow(/Final reply preparation failed/)
    expect(call.deferred).toHaveLength(0)
    expect((await agentToolNames(agent)).sort()).toEqual(['echo'])
  })

  it('fails closed when a scoped tool survives the empty restriction', async () => {
    const { agent, coordinator } = await coordinatorHarness()
    agent.ctx.tools.register(defineContentToolFixture({
      name: 'scoped-tool',
      description: 'Scoped business tool.',
      parameters: { text: { type: 'string', required: true } },
      async execute(args) {
        return [{ type: 'text', text: `scoped: ${String(args.text)}` }]
      },
    }))
    appendStepWithCalls(agent, 1, 1, [{ rawId: 'prepare', name: FINAL_REPLY_TOOL }])
    const call = prepareCall(agent)

    expect(await coordinator.prepare(call.exec)).toEqual({ status: 'refused' })
    expect(call.deferred).toHaveLength(0)
    expect((await agentToolNames(agent)).sort()).toEqual(['echo', 'scoped-tool'])
  })

  it('reuses one logged refresh across provider-style re-entry and expires idempotently', async () => {
    const { agent, coordinator } = await coordinatorHarness()
    const call = await arm(coordinator, agent)
    const voice = call.deferred[0]
    if (voice === undefined) throw new Error('missing voice')
    const first = await coordinator.beforeStep(agent, 1, { kind: 'enter', messages: [voice] })
    expect(first.kind).toBe('enter')
    if (first.kind !== 'enter') throw new Error('unreachable')
    appendMessages(agent, 1, 2, first.messages)

    const retry = await coordinator.beforeStep(agent, 1, { kind: 'enter', messages: [] })
    expect(retry.kind).toBe('enter')
    if (retry.kind !== 'enter') throw new Error('unreachable')
    expect(retry.messages).toEqual([])
    expect(await agentToolNames(agent)).toEqual([])
    expect(eventsWithProjection(agent, 'final-voice-refresh')).toBe(1)

    coordinator.finishTurn(agent, 1)
    coordinator.finishTurn(agent, 1)
    expect(eventsWithProjection(agent, 'final-voice-refresh-consumed')).toBe(1)
  })

  it('settles direct final, prepared final, cancel, error, and dispose with idempotent expiry', async () => {
    const direct = await coordinatorHarness()
    await projectOwnerTurn(direct.coordinator, direct.agent, 1, 'Direct final turn.')
    direct.coordinator.finishTurn(direct.agent, 1)
    direct.coordinator.finishTurn(direct.agent, 1)
    expect(eventsWithProjection(direct.agent, 'turn-voice-consumed')).toBe(1)

    const prepared = await coordinatorHarness()
    const call = await arm(prepared.coordinator, prepared.agent)
    const voice = call.deferred[0]
    if (voice === undefined) throw new Error('missing voice')
    const decision = await prepared.coordinator.beforeStep(prepared.agent, 1, { kind: 'enter', messages: [voice] })
    if (decision.kind !== 'enter') throw new Error('unreachable')
    appendMessages(prepared.agent, 1, 2, decision.messages)
    prepared.coordinator.settle(prepared.agent)
    expect((await agentToolNames(prepared.agent)).sort()).toEqual(['echo'])
    expect(eventsWithProjection(prepared.agent, 'final-voice-refresh-consumed')).toBe(1)
    expect(currentProjectionCount(prepared.agent, 'final-voice-refresh')).toBe(0)

    const cancelled = await coordinatorHarness()
    await projectOwnerTurn(cancelled.coordinator, cancelled.agent, 1, 'Cancel turn.')
    const cancelledArm = await arm(cancelled.coordinator, cancelled.agent)
    const cancelledVoice = cancelledArm.deferred[0]
    if (cancelledVoice === undefined) throw new Error('missing voice')
    const cancelledDecision = await cancelled.coordinator.beforeStep(cancelled.agent, 1, { kind: 'enter', messages: [cancelledVoice] })
    if (cancelledDecision.kind !== 'enter') throw new Error('unreachable')
    appendMessages(cancelled.agent, 1, 2, cancelledDecision.messages)
    cancelled.coordinator.settle(cancelled.agent)
    expect(eventsWithProjection(cancelled.agent, 'turn-voice-superseded')).toBe(1)
    expect(eventsWithProjection(cancelled.agent, 'final-voice-refresh-consumed')).toBe(1)
    expect((await agentToolNames(cancelled.agent)).sort()).toEqual(['echo'])

    const disposed = await coordinatorHarness()
    await projectOwnerTurn(disposed.coordinator, disposed.agent, 1, 'Dispose turn.')
    const disposedArm = await arm(disposed.coordinator, disposed.agent)
    const disposedVoice = disposedArm.deferred[0]
    if (disposedVoice === undefined) throw new Error('missing voice')
    const disposedDecision = await disposed.coordinator.beforeStep(disposed.agent, 1, { kind: 'enter', messages: [disposedVoice] })
    if (disposedDecision.kind !== 'enter') throw new Error('unreachable')
    appendMessages(disposed.agent, 1, 2, disposedDecision.messages)
    disposed.coordinator.dispose()
    expect((await agentToolNames(disposed.agent)).sort()).toEqual(['echo'])
    expect(eventsWithProjection(disposed.agent, 'turn-voice-superseded')).toBe(1)
    expect(eventsWithProjection(disposed.agent, 'final-voice-refresh-consumed')).toBe(1)
  })

  it('keeps one armed agent from changing another agent tool list or capsule', async () => {
    const { ctx, agent, coordinator } = await coordinatorHarness()
    const other = ctx.agentLoop.create(SessionId(`coordinator-other-${crypto.randomUUID()}`), { provider: 'mock', model: 'mock' })
    await arm(coordinator, agent)
    const otherMessages = await projectOwnerTurn(coordinator, other, 1, 'Other owner message.')

    expect(await agentToolNames(agent)).toEqual([])
    expect((await agentToolNames(other)).sort()).toEqual(['echo'])
    expect(otherMessages).toHaveLength(2)
    expect(voiceProjectionOf(otherMessages[1]?.source)).toBe('turn-voice')
    coordinator.settle(agent)
    coordinator.settle(other)
  })

  it('Code Mode keeps run_code unchanged, delivers owner-tail only, and refuses nested prepare calls', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mistymoon-code-mode-'))
    await writePersona(home)
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SystemPrompt, { includeHarnessIdentity: true, persona: 'Neutral preset persona.' })
    await ctx.plugin(ToolRuntime, { mode: 'code' })
    ctx.provide('codeRuntime', { language: 'python' })
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentLoop, { agents: [] })
    ctx.tools.register(defineContentToolFixture({
      name: 'echo',
      description: 'Echo the given text.',
      parameters: { text: { type: 'string', required: true } },
      async execute(args) {
        return [{ type: 'text', text: `echo: ${String(args.text)}` }]
      },
    }))
    const adapter = new ScriptedAdapter([textResponse('code mode direct final')])
    ctx.llm.registerAdapter(['mock'], adapter)
    await ctx.plugin(IdentityPlugin, { ownerId: 'owner-fixture' })
    await ctx.plugin(FoundationPlugin, { home, defaultRoleplayMode: 'companion' })
    const agent = ctx.agentLoop.create(SessionId(`code-mode-${crypto.randomUUID()}`), { provider: 'mock', model: 'mock' })

    expect((await agentToolNames(agent))).toEqual(['run_code'])
    const assembly = await agent.ctx.systemPrompt.assemble(assembleContextFor(agent))
    expect(assembly.sections.some(section => section.name.startsWith('mistymoon:'))).toBe(false)

    agent.followup(ownerMessage('Code Mode direct owner message.'))
    await agent.whenIdle()
    expect(adapter.requests).toHaveLength(1)
    const request = adapter.requests[0]!
    expect((request.tools ?? []).map(tool => tool.name)).toEqual(['run_code'])
    expect((request.system ?? '')).not.toContain('MistyMoon')
    expect(request.messages.filter(message => voiceProjectionOf(message.source) === 'turn-voice')).toHaveLength(1)
    expect(request.messages.filter(message => voiceProjectionOf(message.source) === 'final-voice-refresh')).toHaveLength(0)
    expect(eventsWithProjection(agent, 'turn-voice-consumed')).toBe(1)

    appendStepWithCalls(agent, 2, 1, [{ rawId: 'prepare', name: FINAL_REPLY_TOOL }])
    const coordinator = new PersonaTurnDeliveryCoordinator({
      ownerEligibility: ownerEligibility(),
      defaultMode: 'companion',
      personaPath: join(home, 'persona.json'),
      turnVoiceMaxChars: DEFAULT_TURN_VOICE_MAX_CHARS,
    })
    const nested = prepareCall(agent, { parent: true })
    expect(await coordinator.prepare(nested.exec)).toEqual({ status: 'refused' })
    expect(nested.deferred).toHaveLength(0)
  })
})

/** Build one balanced prepared-final seed whose final request never happened. */
function buildPreparedSeed(session: Session, options: { refresh: 'logged' | 'inbox' | 'none' }): void {
  const callId = CallId('resume-prepare')
  const refreshText = renderFinalVoiceRefresh(NEUTRAL_PERSONA, 'companion')
  const refresh = createUserMessage({
    content: [{ type: 'text', text: refreshText }],
    source: {
      kind: 'mistymoon-voice',
      plugin: 'mistymoon-foundation',
      form: 'snapshot',
      sections: [{ name: FINAL_VOICE_REFRESH_SECTION, text: refreshText }],
      projection: 'final-voice-refresh',
      turn: 1,
      estimatedTokens: Math.ceil(refreshText.length / 4),
      personaVersion: 2,
      personaHash: 'f'.repeat(64),
    },
  })
  const capsuleText = renderTurnVoice(NEUTRAL_PERSONA, DEFAULT_TURN_VOICE_MAX_CHARS)
  const capsule = createUserMessage({
    content: [{ type: 'text', text: capsuleText }],
    source: {
      kind: 'mistymoon-voice',
      plugin: 'mistymoon-foundation',
      form: 'snapshot',
      sections: [{ name: TURN_VOICE_SECTION, text: capsuleText }],
      projection: 'turn-voice',
      turn: 1,
      estimatedTokens: Math.ceil(capsuleText.length / 4),
      personaVersion: 2,
      personaHash: 'f'.repeat(64),
    },
  })
  const supersededText = renderTurnVoiceSuperseded()
  const superseded = createUserMessage({
    content: [{ type: 'text', text: supersededText }],
    source: {
      kind: 'mistymoon-voice',
      plugin: 'mistymoon-foundation',
      form: 'snapshot',
      sections: [{ name: TURN_VOICE_SUPERSEDED_SECTION, text: supersededText }],
      projection: 'turn-voice-superseded',
      turn: 1,
      estimatedTokens: Math.ceil(supersededText.length / 4),
    },
  })

  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  session.append('user/message', ownerMessage('Resume seed owner message.'), { surfaceOp: 'append' })
  const capsuleEvent = session.append('user/message', capsule, { surfaceOp: 'append' })
  session.append('user/message', superseded, {
    surfaceOp: { op: 'replace', start: capsuleEvent.seq, end: capsuleEvent.seq },
    sourceEventSeqs: [capsuleEvent.seq],
  })
  session.append('assistant/message', {
    turn: 1,
    step: 1,
    message: createAssistantMessage({
      content: [{ type: 'tool-call', id: callId, name: FINAL_REPLY_TOOL, arguments: '{}' }],
      source: { provider: 'mock', model: 'mock' },
    }),
  }, { surfaceOp: 'append', sourceEventSeqs: [] })
  const toolCall = session.append('tool/call', { turn: 1, step: 1, callId, name: FINAL_REPLY_TOOL, arguments: '{}' })
  session.append('tool/result', {
    turn: 1,
    step: 1,
    message: createToolResultMessage({
      callId,
      content: [{ type: 'text', text: 'Final reply prepared: the next assistant output is the owner-facing final reply, with no tools available.' }],
      isError: false,
    }),
    meta: { kind: 'mistymoon-prepare', status: 'armed' },
  }, { surfaceOp: 'append', sourceEventSeqs: [toolCall.seq] })
  if (options.refresh === 'logged') {
    session.append('user/message', refresh, { surfaceOp: 'append' })
  } else if (options.refresh === 'inbox') {
    session.append('agent/inbox/spliced', { target: 'next-step', start: 0, inserted: [refresh] })
  }
  session.append('step/end', { turn: 1, step: 1 })
  session.append('turn/end', { turn: 1, reason: { kind: 'interrupted' } })
}

async function resumeHarness(refresh: 'logged' | 'inbox' | 'none', viaOfficialResume = false) {
  const home = await mkdtemp(join(tmpdir(), 'mistymoon-turn-resume-'))
  await writePersona(home)
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, { includeHarnessIdentity: true, persona: 'Neutral preset persona.' })
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.tools.register(defineContentToolFixture({
    name: 'echo',
    description: 'Echo the given text.',
    parameters: { text: { type: 'string', required: true } },
    async execute(args) {
      return [{ type: 'text', text: `echo: ${String(args.text)}` }]
    },
  }))
  await ctx.plugin(IdentityPlugin, { ownerId: 'owner-fixture' })
  await ctx.plugin(FoundationPlugin, { home, defaultRoleplayMode: 'companion', turnVoiceMaxChars: DEFAULT_TURN_VOICE_MAX_CHARS })
  const adapter = new ScriptedAdapter([textResponse('resumed final reply')])
  ctx.llm.registerAdapter(['mock'], adapter)

  const seedSession = ctx.sessions.prepare(SessionId(`resume-seed-${crypto.randomUUID()}`))
  buildPreparedSeed(seedSession, { refresh })
  const seed = structuredClone([...seedSession.events])
  const resumeAgentId = SessionId(`resume-agent-${crypto.randomUUID()}`)
  const handle = viaOfficialResume
    ? await (async () => {
      const persistence = {
        async prepare(id: SessionId, signal?: AbortSignal) {
          signal?.throwIfAborted()
          const session = ctx.sessions.prepare(id, { seed: structuredClone(seed) })
          return SessionPreparation.create(session)
        },
      }
      ctx.provide('sessionPersistence' as never, persistence as never)
      return ctx.agents.resume({
        resumeSessionId: resumeAgentId,
        agentOptions: { provider: 'mock', model: 'mock' },
      })
    })()
    : await ctx.agents.create({
      sessionId: resumeAgentId,
      seed,
      agentOptions: { provider: 'mock', model: 'mock' },
    })
  return { ctx, adapter, agent: handle.agent, handle }
}

describe('durable restart and resume', () => {
  it('rebuilds the empty-tool gate from a logged refresh through the official resume seam without re-preparing', async () => {
    const { adapter, agent } = await resumeHarness('logged', true)
    agent.followup(ownerMessage('Resume continuation owner message.'))
    await agent.whenIdle()

    expect(adapter.requests).toHaveLength(1)
    const request = adapter.requests[0]!
    expect(request.tools ?? []).toEqual([])
    expect(request.messages.filter(message => voiceProjectionOf(message.source) === 'final-voice-refresh')).toHaveLength(1)
    expect(request.messages.filter(message => voiceProjectionOf(message.source) === 'turn-voice')).toHaveLength(1)
    expect(eventsWithProjection(agent, 'final-voice-refresh')).toBe(1)
    expect(eventsWithProjection(agent, 'turn-voice')).toBe(2)
    expect(eventsWithProjection(agent, 'turn-voice-superseded')).toBe(1)
    expect(agent.session.events.filter(event => event.type === 'tool/call' && event.data.name === FINAL_REPLY_TOOL)).toHaveLength(1)
    expect(eventsWithProjection(agent, 'final-voice-refresh-consumed')).toBe(1)
    expect(eventsWithProjection(agent, 'turn-voice-consumed')).toBe(1)
  })

  it('rebuilds the empty-tool gate from a pending inbox refresh through the official resume seam without re-preparing', async () => {
    const { adapter, agent } = await resumeHarness('inbox', true)
    agent.followup(ownerMessage('Resume continuation owner message.'))
    await agent.whenIdle()

    expect(adapter.requests).toHaveLength(1)
    const request = adapter.requests[0]!
    expect(request.tools ?? []).toEqual([])
    expect(request.messages.filter(message => voiceProjectionOf(message.source) === 'final-voice-refresh')).toHaveLength(1)
    expect(request.messages.filter(message => voiceProjectionOf(message.source) === 'turn-voice')).toHaveLength(1)
    expect(eventsWithProjection(agent, 'final-voice-refresh')).toBe(1)
    expect(eventsWithProjection(agent, 'turn-voice')).toBe(2)
    expect(eventsWithProjection(agent, 'turn-voice-superseded')).toBe(1)
    expect(agent.session.events.filter(event => event.type === 'tool/call' && event.data.name === FINAL_REPLY_TOOL)).toHaveLength(1)
    expect(eventsWithProjection(agent, 'final-voice-refresh-consumed')).toBe(1)
    expect(eventsWithProjection(agent, 'turn-voice-consumed')).toBe(1)
  })

  it('fails closed without a refresh and keeps ordinary DSH tools', async () => {
    const { adapter, agent } = await resumeHarness('none')
    agent.followup(ownerMessage('Ambiguous resume owner message.'))
    await agent.whenIdle()

    expect(adapter.requests).toHaveLength(1)
    const request = adapter.requests[0]!
    expect(request.tools?.map(tool => tool.name).sort()).toEqual(['echo', 'mistymoon_prepare_final_reply'])
    expect(request.messages.filter(message => voiceProjectionOf(message.source) === 'final-voice-refresh')).toHaveLength(0)
    expect(eventsWithProjection(agent, 'final-voice-refresh')).toBe(0)
  })
})
