import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { assembleContextFor, type Agent } from '@deepseek-ai/dsh-agent'
import { CallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import { createScope } from '@deepseek-ai/dsh-scope'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import { describe, expect, it } from 'vitest'
import {
  FINAL_REPLY_TOOL,
  PersonaTurnDeliveryCoordinator,
  PublishedPersonaProjection,
  RoleplayController,
  renderPersona,
  type PersonaDocument,
} from '../src/index.js'
import * as RpHostCompositionPlugin from '../src/rp-host-composition.js'
import { loopHarness, send, waitForIdle } from './support/loop-harness.js'
import { ScriptedAdapter, textResponse } from './support/mock-llm.js'

function persona(displayName: string): PersonaDocument {
  return {
    schemaVersion: 2,
    kind: 'mistymoon.persona',
    displayName,
    identity: {
      summary: `${displayName} is a neutral fixture companion.`,
      relationship: 'Continue only from observed shared context.',
      familiarRelationship: 'Use only disclosable shared context.',
      strangerRelationship: 'Be polite without assumed familiarity.',
    },
    style: {
      tone: ['warm', 'precise'],
      instructions: 'Keep casual replies natural and facts exact.',
      avoid: ['invented history'],
    },
    advancedInstructions: 'State uncertainty plainly.',
    referenceDialogs: [{ user: 'Can you check?', assistant: 'I will verify it first.' }],
    responseBudgets: {
      brief: { targetCharacters: 40, maxOutputTokens: 100 },
      normal: { targetCharacters: 200, maxOutputTokens: 500 },
      deep: { targetCharacters: 800, maxOutputTokens: 1600 },
    },
    boundaries: { privateByDefault: true, requireApprovalForExternalActions: true },
  }
}

async function personaPath(initial: PersonaDocument): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'mistymoon-rp-host-'))
  const path = join(home, 'persona', 'persona.json')
  await mkdir(join(home, 'persona'), { recursive: true })
  await writeFile(path, `${JSON.stringify(initial)}\n`, 'utf8')
  return path
}

function registerFixtureTool(ctx: Context, name: string): void {
  if (name === 'read') {
    ctx.tools.register(defineContentToolFixture({
      name,
      description: `${name} fixture`,
      parameters: { file_path: { type: 'string', required: true } },
      async execute() { return [{ type: 'text', text: 'ok' }] },
    }))
    return
  }
  if (name === 'grep' || name === 'glob') {
    ctx.tools.register(defineContentToolFixture({
      name,
      description: `${name} fixture`,
      parameters: {
        pattern: { type: 'string', required: true },
        path: { type: 'string' },
      },
      async execute() { return [{ type: 'text', text: 'ok' }] },
    }))
    return
  }
  ctx.tools.register(defineContentToolFixture({
    name,
    description: `${name} fixture`,
    parameters: {},
    async execute() { return [{ type: 'text', text: 'ok' }] },
  }))
}

async function registerRpHostToolSurface(ctx: Context, extras: readonly string[] = []): Promise<void> {
  await ctx.plugin({
    name: 'rp-host-tool-surface-fixture',
    inject: ['tools'],
    apply(toolCtx: Context) {
      for (const name of RpHostCompositionPlugin.RP_HOST_TOOL_ALLOWLIST) {
        registerFixtureTool(toolCtx, name)
      }
      for (const name of extras) registerFixtureTool(toolCtx, name)
    },
  })
}

function provideRpServices(
  ctx: Context,
  projection: PublishedPersonaProjection,
  controller = new RoleplayController('immersive'),
): void {
  ctx.effect(() => ctx.provide('mistymoonPersonaProjection', projection))
  ctx.effect(() => ctx.provide('mistymoonRoleplay', controller))
}

describe('RP Host Composition', () => {
  it('projects the complete published Persona in the protected system slot and refreshes after publication', async () => {
    const first = persona('Luna')
    const path = await personaPath(first)
    const projection = await PublishedPersonaProjection.load(path)
    const ctx = new Context()
    await ctx.plugin(SystemPrompt, { includeHarnessIdentity: true, persona: 'Deployment fallback.' })
    await ctx.plugin(ToolRuntime)
    registerFixtureTool(ctx, FINAL_REPLY_TOOL)
    await registerRpHostToolSurface(ctx)
    provideRpServices(ctx, projection)
    const key = {}
    const scope = createScope(ctx, key)
    await scope.ctx.plugin(RpHostCompositionPlugin)
    const agent = {
      id: SessionId('rp-project'),
      session: Session.create(SessionId('rp-project-session')),
    } as Agent

    const firstAssembly = await ctx.systemPrompt.assemble({ scope: key, agent } as never)
    expect(firstAssembly.sections.filter(section => section.name === 'deployment:persona'))
      .toEqual([{ name: 'deployment:persona', text: renderPersona(first) }])
    expect(renderPrompt(firstAssembly)).not.toContain('You are an AI agent powered by DeepSeek Harness.')
    expect(renderPrompt(firstAssembly)).toContain('Example 1 Luna: I will verify it first.')

    const second = persona('Nova')
    await writeFile(path, `${JSON.stringify(second)}\n`, 'utf8')
    const before = projection.current().fingerprint
    await projection.refresh()
    const secondAssembly = await ctx.systemPrompt.assemble({ scope: key, agent } as never)

    expect(renderPrompt(secondAssembly)).toContain('You are Nova.')
    expect(renderPrompt(secondAssembly)).not.toContain('You are Luna.')
    expect(projection.current().fingerprint).not.toBe(before)
  })

  it('hides the legacy final-reply tool without removing read-only Web tools', async () => {
    const projection = await PublishedPersonaProjection.load(await personaPath(persona('Luna')))
    const ctx = new Context()
    await ctx.plugin(SystemPrompt, { includeHarnessIdentity: false, persona: 'Fallback.' })
    await ctx.plugin(ToolRuntime)
    registerFixtureTool(ctx, FINAL_REPLY_TOOL)
    provideRpServices(ctx, projection)
    const key = {}
    const scope = createScope(ctx, key)
    await registerRpHostToolSurface(scope.ctx, ['write'])
    await scope.ctx.plugin(RpHostCompositionPlugin)

    const tools = (await ctx.systemPrompt.assemble({ scope: key })).tools.map(tool => tool.name)
    expect(tools).toHaveLength(RpHostCompositionPlugin.RP_HOST_TOOL_ALLOWLIST.length)
    expect(tools).toEqual(expect.arrayContaining([...RpHostCompositionPlugin.RP_HOST_TOOL_ALLOWLIST]))
    expect(() => ctx.tools.get(FINAL_REPLY_TOOL)).not.toThrow()
  })

  it('keeps unclassified tool policy while using the published Persona as the RP Host identity', async () => {
    const projection = await PublishedPersonaProjection.load(await personaPath(persona('Luna')))
    const ctx = new Context()
    await ctx.plugin(SystemPrompt, { includeHarnessIdentity: true, persona: 'Fallback.' })
    await ctx.plugin(ToolRuntime)
    await registerRpHostToolSurface(ctx)
    provideRpServices(ctx, projection)
    ctx.systemPrompt.section({ name: 'tool:read', order: 100, text: 'Use the read tool.' })
    ctx.systemPrompt.section({ name: 'tool:write', order: 101, text: 'Use the write tool.' })
    ctx.systemPrompt.section({ name: 'plan', order: 200, text: 'Plan rules.' })
    const key = {}
    const scope = createScope(ctx, key)
    await scope.ctx.plugin(RpHostCompositionPlugin)
    const agent = {
      id: SessionId('rp-filter'),
      session: Session.create(SessionId('rp-filter-session')),
    } as Agent

    const assembly = await ctx.systemPrompt.assemble({ scope: key, agent } as never)

    expect(assembly.sections.map(section => section.name)).not.toContain('harness:identity')
    expect(assembly.sections.map(section => section.name)).toContain('tool:write')
    expect(assembly.sections.map(section => section.name)).toContain('tool:read')
    expect(assembly.sections.map(section => section.name)).toContain('plan')
  })

  it('removes the complete Persona only when the RP presentation level is off', async () => {
    const projection = await PublishedPersonaProjection.load(await personaPath(persona('Luna')))
    const ctx = new Context()
    await ctx.plugin(SystemPrompt, { includeHarnessIdentity: true, persona: 'Deployment fallback.' })
    await ctx.plugin(ToolRuntime)
    registerFixtureTool(ctx, FINAL_REPLY_TOOL)
    await registerRpHostToolSurface(ctx)
    provideRpServices(ctx, projection, {
      defaultMode: 'immersive',
      get: () => ({ mode: 'off' }),
    } as RoleplayController)
    const key = {}
    const scope = createScope(ctx, key)
    await scope.ctx.plugin(RpHostCompositionPlugin)
    const agent = { id: SessionId('rp-off') } as Agent

    const assembly = await ctx.systemPrompt.assemble({ scope: key, agent } as never)

    expect(assembly.sections.find(section => section.name === 'deployment:persona')?.text).toBe('')
    expect(renderPrompt(assembly)).not.toContain('Luna')
  })

  it('bypasses legacy turn-voice delivery only for the RP Host strategy', async () => {
    const owner = createUserMessage({ content: [{ type: 'text', text: 'Hello.' }], source: { kind: 'user' } })
    const coordinator = new PersonaTurnDeliveryCoordinator({
      ownerEligibility: {
        ownerMessages: () => [owner],
        evaluateCurrentTurn: () => ({ eligible: true }),
      },
      defaultMode: 'immersive',
      personaPath: await personaPath(persona('Luna')),
      turnVoiceMaxChars: 1200,
      deliveryStrategy: () => 'rp-host-system',
    })
    const agent = {
      id: SessionId('rp-host-agent'),
      session: Session.create(SessionId('rp-host-session')),
    } as unknown as Agent

    const decision = await coordinator.beforeStep(agent, 1, { kind: 'enter', messages: [owner] })

    expect(decision).toEqual({ kind: 'enter', messages: [owner] })
    expect(agent.session.events).toEqual([])
  })

  it('keeps the model the Web UI selected while preserving direct owner-facing output', async () => {
    const adapter = new ScriptedAdapter([textResponse('Direct RP Host reply.')])
    const { ctx } = await loopHarness(adapter)
    await registerRpHostToolSurface(ctx)
    const handle = await ctx.agents.create({
      sessionId: SessionId('rp-host-route'),
      meta: { agentPreset: 'mistymoon-rp-host-v2' },
      agentOptions: { provider: 'mock', model: 'ui-selected-model' },
      async setup(agentCtx) {
        await agentCtx.plugin(RpHostCompositionPlugin)
      },
    })
    try {
      send(handle.agent, 'Give a neutral direct reply.')
      await waitForIdle(ctx, handle.agent)

      expect(adapter.requests).toHaveLength(1)
      expect(adapter.requests[0]).toMatchObject({
        provider: 'mock',
        model: 'ui-selected-model',
      })
      expect(adapter.requests[0]?.system).toContain('You are Luna.')
      expect(adapter.requests[0]?.tools?.map(tool => tool.name)).not.toContain(FINAL_REPLY_TOOL)
      expect(handle.agent.session.events.some(event => event.type === 'user/message'
        && event.data.source.kind === 'mistymoon-voice')).toBe(false)
    } finally {
      await handle.dispose()
    }
  })

  it('allows read, grep, and glob inside the session workspace and denies paths outside it', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'mistymoon-rp-workspace-'))
    const outside = await mkdtemp(join(tmpdir(), 'mistymoon-rp-outside-'))
    const workspaceFile = join(workspace, 'neutral.txt')
    const outsideFile = join(outside, 'neutral.txt')
    await writeFile(workspaceFile, 'neutral fixture\n', 'utf8')
    await writeFile(outsideFile, 'neutral fixture\n', 'utf8')
    const adapter = new ScriptedAdapter([])
    const { ctx } = await loopHarness(adapter)
    const handle = await ctx.agents.create({
      sessionId: SessionId('rp-host-workspace-boundary'),
      meta: { agentPreset: 'mistymoon-rp-host-v2', cwd: workspace },
      agentOptions: { provider: 'mock', model: 'ui-selected-model' },
      async setup(agentCtx) {
        await registerRpHostToolSurface(agentCtx)
        await agentCtx.plugin(RpHostCompositionPlugin)
      },
    })
    try {
      await handle.agent.ctx.plugin({
        name: 'late-rp-host-tool-fixture',
        inject: ['tools'],
        apply(toolCtx: Context) {
          registerFixtureTool(toolCtx, 'late_hmr_tool')
        },
      })
      const afterLateRegistration = await handle.agent.ctx.systemPrompt.assemble(assembleContextFor(handle.agent))
      expect(afterLateRegistration.tools.map(tool => tool.name)).not.toContain('late_hmr_tool')
      const lateResult = await ctx.tools.execute({
        signal: new AbortController().signal,
        callId: CallId('late-hmr-tool'),
        name: 'late_hmr_tool',
        arguments: {},
        agent: handle.agent,
      })
      expect(lateResult.isError).toBe(true)
      expect(lateResult.content).toEqual(expect.arrayContaining([
        expect.objectContaining({
          type: 'text',
          text: expect.stringContaining('RP Host may use only'),
        }),
      ]))

      const insideCalls = [
        { name: 'read', arguments: { file_path: workspaceFile } },
        { name: 'grep', arguments: { pattern: 'neutral', path: workspace } },
        { name: 'glob', arguments: { pattern: '**/*', path: workspace } },
      ] as const
      for (const [index, call] of insideCalls.entries()) {
        const result = await ctx.tools.execute({
          signal: new AbortController().signal,
          callId: CallId(`inside-${String(index)}`),
          name: call.name,
          arguments: call.arguments,
          agent: handle.agent,
        })
        expect(result.isError).toBe(false)
      }
      const calls = [
        { name: 'read', arguments: { file_path: outsideFile } },
        { name: 'grep', arguments: { pattern: 'neutral', path: relative(workspace, outside) } },
        { name: 'glob', arguments: { pattern: '**/*', path: outside } },
      ] as const
      for (const [index, call] of calls.entries()) {
        const result = await ctx.tools.execute({
          signal: new AbortController().signal,
          callId: CallId(`outside-${String(index)}`),
          name: call.name,
          arguments: call.arguments,
          agent: handle.agent,
        })
        expect(result.isError).toBe(true)
        expect(result.content).toEqual(expect.arrayContaining([
          expect.objectContaining({
            type: 'text',
            text: expect.stringContaining('current session workspace'),
          }),
        ]))
      }
    } finally {
      await handle.dispose()
    }
  })

  it('fails closed instead of treating an arbitrary Symbol value as the RP Host scope', async () => {
    const projection = await PublishedPersonaProjection.load(await personaPath(persona('Luna')))
    const ctx = new Context()
    await ctx.plugin(SystemPrompt, { includeHarnessIdentity: true, persona: 'Fallback.' })
    await ctx.plugin(ToolRuntime)
    await registerRpHostToolSurface(ctx)
    provideRpServices(ctx, projection)
    Object.defineProperty(ctx, Symbol('foreign-dsh-scope'), {
      value: { agentPreset: 'mistymoon-rp-host-v2' },
      enumerable: false,
    })

    await expect(ctx.plugin(RpHostCompositionPlugin))
      .rejects.toThrow('mistymoon-rp-host: tool policy requires a DSH scope')
  })
})
