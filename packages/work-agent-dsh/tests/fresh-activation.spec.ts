import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentRegistry, { assembleContextFor } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import AgentPresets from '@deepseek-ai/dsh-agent-presets'
import LlmRuntime, {
  createUserMessage,
  LlmAdapter,
  ReasoningEffortId,
  type GenerateOptions,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import {
  prepareWorkActivationPublication,
  SharedBaselineRegistry,
  WorkPresetResolver,
  type SharedBaselineDefinitionV1,
  type WorkActivationPolicyV1,
  type WorkPresetManifestV1,
} from '@mistymoon/dsh-work-agent'
import { describe, expect, it } from 'vitest'
import {
  createFixedWorkPresetProvider,
  createFreshWorkActivation,
  createGovernedWorkPresetProvider,
  StaleWorkActivationPublicationError,
} from '../src/index.js'

const FIXTURE_PLUGIN = fileURLToPath(new URL('./fixtures/preset-plugin.mjs', import.meta.url))

class RecordingAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  private readonly requestWaiters: Array<() => void> = []

  constructor(private readonly behavior: 'complete' | 'hang' = 'complete') {
    super()
  }

  override resolveModel(provider: string, model: string) {
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      reasoning: {
        efforts: [
          { id: ReasoningEffortId('high'), name: 'High' },
          { id: ReasoningEffortId('max'), name: 'Max' },
        ],
      },
    })
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    for (const resolve of this.requestWaiters.splice(0)) resolve()
    yield { type: 'block-start', index: 0, blockType: 'text' }
    if (this.behavior === 'hang') {
      yield { type: 'text-delta', index: 0, text: 'partial' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'partial' } }
      await new Promise<never>((_resolve, reject) => {
        if (options.signal?.aborted) {
          reject(new Error('aborted'))
          return
        }
        options.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      })
    }
    yield { type: 'text-delta', index: 0, text: 'done' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'done' } }
    yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }

  waitForRequest(): Promise<void> {
    if (this.requests.length > 0) return Promise.resolve()
    return new Promise(resolve => this.requestWaiters.push(resolve))
  }
}

async function writePreset(
  root: string,
  id: string,
  config: { sectionName: string; prompt: string; toolName: string; failSetup?: boolean },
): Promise<void> {
  const directory = join(root, id)
  await mkdir(directory, { recursive: true })
  const pluginPath = FIXTURE_PLUGIN.replaceAll('\\', '/')
  await writeFile(join(directory, 'agent.cordis.yml'), [
    '- id: fixture',
    `  name: ${JSON.stringify(pluginPath)}`,
    '  config:',
    `    sectionName: ${JSON.stringify(config.sectionName)}`,
    `    prompt: ${JSON.stringify(config.prompt)}`,
    `    toolName: ${JSON.stringify(config.toolName)}`,
    ...(config.failSetup === true ? ['    failSetup: true'] : []),
    '',
  ].join('\n'), 'utf8')
}

async function harness(adapter = new RecordingAdapter()) {
  const root = await mkdtemp(join(tmpdir(), 'mistymoon-work-activation-'))
  await writePreset(root, 'rp-parent', {
    sectionName: 'fixture:rp-parent',
    prompt: 'RP parent prompt must stay outside the Work Agent.',
    toolName: 'rp_private',
  })
  await writePreset(root, 'work-child', {
    sectionName: 'fixture:work-child',
    prompt: 'Neutral Work Agent prompt.',
    toolName: 'work_read',
  })

  const ctx = new Context()
  await ctx.plugin(Loader, { baseUrl: dirname(FIXTURE_PLUGIN) })
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, { includeHarnessIdentity: true })
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(AgentPresets, {
    default: 'rp-parent',
    roots: [{ path: root, trust: 'system' }],
    includeUserRoot: false,
  })
  await ctx.plugin(SubagentRuntime)
  ctx.llm.registerAdapter(['mock', 'deepseek-official'], adapter)

  let activationCtx: Context | undefined
  let parentPromise: ReturnType<typeof ctx.agents.create> | undefined
  const ownerFiber = ctx.inject(['agents', 'agentPresets', 'subagents'], (injectedCtx) => {
    activationCtx = injectedCtx
    parentPromise = injectedCtx.agents.create({
      sessionId: SessionId(`rp-parent-${crypto.randomUUID()}`),
      meta: { agentPreset: 'rp-parent' },
      agentOptions: { provider: 'mock', model: 'parent-model' },
      async setup(agentCtx) {
        await injectedCtx.agentPresets.mount(agentCtx, 'rp-parent')
      },
    })
  })
  await ownerFiber
  if (activationCtx === undefined || parentPromise === undefined) {
    throw new Error('injected activation context did not start')
  }
  const parent = await parentPromise
  return { activationCtx, adapter, ctx, ownerFiber, parent, root }
}

describe('createFreshWorkActivation', () => {
  it('publishes an empty depth-one child under its selected Work preset', async () => {
    const { activationCtx, adapter, ctx, ownerFiber, parent } = await harness()
    const childId = SessionId(`work-child-${crypto.randomUUID()}`)
    const signal = new AbortController().signal

    const child = await createFreshWorkActivation(activationCtx, {
      parent: parent.agent,
      childSessionId: childId,
      nativePresetId: 'work-child',
      agentOptions: { provider: 'mock', model: 'work-model' },
      signal,
      validatePublication: () => 'valid',
    })

    expect(ctx.agentPresets.composedPreset(parent.agent.ctx)).toBe('rp-parent')
    expect(ctx.agentPresets.composedPreset(child.agent.ctx)).toBe('work-child')
    expect(ctx.agents.isOwnedBy(childId, parent.agent)).toBe(true)
    expect(child.agent.session.header).toMatchObject({
      id: childId,
      parentSession: parent.agent.id,
      seedLength: 0,
      origin: 'subagent',
      delegationDepth: 1,
      agentPreset: 'work-child',
    })
    expect(child.agent.session.events).toEqual([])
    expect(child.agent.options).toMatchObject({
      provider: 'mock',
      model: 'work-model',
      subagentDepth: 1,
    })

    const assembly = await child.agent.ctx.systemPrompt.assemble(assembleContextFor(child.agent))
    expect(assembly.sections.map(section => section.name)).toContain('fixture:work-child')
    expect(assembly.sections.map(section => section.name)).not.toContain('fixture:rp-parent')
    expect(assembly.tools.map(tool => tool.name)).toEqual(['work_read'])

    child.agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'Inspect the neutral fixture.' }],
      source: { kind: 'user' },
    }))
    await child.agent.whenIdle()

    expect(adapter.requests).toHaveLength(1)
    expect(adapter.requests[0]?.model).toBe('work-model')
    expect(adapter.requests[0]?.system).toContain('Neutral Work Agent prompt.')
    expect(adapter.requests[0]?.system).not.toContain('RP parent prompt')
    expect(adapter.requests[0]?.tools?.map(tool => tool.name)).toEqual(['work_read'])
    expect(child.agent.session.requestHeader()).toMatchObject({
      config: { provider: 'mock', model: 'work-model' },
      tools: [expect.objectContaining({ name: 'work_read' })],
    })

    await child.dispose()
    await parent.dispose()
    await ownerFiber.dispose()
  })

  it.each([
    { id: 'missing-work', provision: false, message: /not found/ },
    { id: 'broken-work', provision: true, message: /neutral preset fixture setup failed/ },
  ])('leaves no child when preset $id cannot be mounted', async ({ id, provision, message }) => {
    const { activationCtx, ctx, ownerFiber, parent, root } = await harness()
    const childId = SessionId(`${id}-${crypto.randomUUID()}`)
    if (provision) {
      await writePreset(root, id, {
        sectionName: `fixture:${id}`,
        prompt: 'This failing prompt must never become visible.',
        toolName: 'never_visible',
        failSetup: true,
      })
    }

    try {
      await expect(createFreshWorkActivation(activationCtx, {
        parent: parent.agent,
        childSessionId: childId,
        nativePresetId: id,
        signal: new AbortController().signal,
        validatePublication: () => 'valid',
      })).rejects.toThrow(message)
      expect(ctx.agents.get(childId)).toBeUndefined()
      expect(ctx.sessions.get(childId)).toBeUndefined()
      expect(ctx.agentPresets.composedPreset(parent.agent.ctx)).toBe('rp-parent')
    } finally {
      await parent.dispose()
      await ownerFiber.dispose()
    }
  })

  it('rolls back the unpublished child when the governed selection changes before publication', async () => {
    const { activationCtx, ctx, ownerFiber, parent } = await harness()
    const childId = SessionId(`stale-work-child-${crypto.randomUUID()}`)
    let returned: Awaited<ReturnType<typeof createFreshWorkActivation>> | undefined
    let caught: unknown

    try {
      returned = await createFreshWorkActivation(activationCtx, {
        parent: parent.agent,
        childSessionId: childId,
        nativePresetId: 'work-child',
        signal: new AbortController().signal,
        validatePublication() {
          throw new Error('governed Work preset selection changed')
        },
      })
    } catch (error) {
      caught = error
    }

    try {
      expect(caught).toEqual(expect.objectContaining({
        message: 'governed Work preset selection changed',
      }))
      expect(ctx.agents.get(childId)).toBeUndefined()
      expect(ctx.sessions.get(childId)).toBeUndefined()
      expect(ctx.agentPresets.composedPreset(parent.agent.ctx)).toBe('rp-parent')
    } finally {
      await returned?.dispose()
      await parent.dispose()
      await ownerFiber.dispose()
    }
  })
})

describe('createFixedWorkPresetProvider', () => {
  it('runs separate one-shot Sessions for two presets that share one baseline', async () => {
    const { activationCtx, adapter, ctx, ownerFiber, parent, root } = await harness()
    await writePreset(root, 'work-advanced', {
      sectionName: 'fixture:work-advanced',
      prompt: 'Neutral advanced Work Agent prompt.',
      toolName: 'work_complex',
    })
    const baselineFingerprint = 'a'.repeat(64)
    const defaultProvider = createFixedWorkPresetProvider(activationCtx, {
      name: 'mistymoon-work-default-fixture',
      selection: {
        version: 1,
        nativePresetId: 'work-child',
        baselineFingerprint,
        presetFingerprint: 'b'.repeat(64),
      },
      toolRestriction: { allow: ['work_read'] },
      validatePublication: () => 'valid',
    })
    const advancedProvider = createFixedWorkPresetProvider(activationCtx, {
      name: 'mistymoon-work-advanced-fixture',
      selection: {
        version: 1,
        nativePresetId: 'work-advanced',
        baselineFingerprint,
        presetFingerprint: 'c'.repeat(64),
      },
      toolRestriction: { allow: ['work_complex'] },
      validatePublication: () => 'valid',
    })
    const removeDefault = activationCtx.subagents.registerProvider(defaultProvider)
    const removeAdvanced = activationCtx.subagents.registerProvider(advancedProvider)
    const runs = []

    try {
      for (const provider of [defaultProvider.name, advancedProvider.name]) {
        const run = await activationCtx.subagents.start(provider, {
          parent: parent.agent,
          prompt: [{ type: 'text', text: `Run ${provider}.` }],
          signal: new AbortController().signal,
        })
        runs.push(run)
        const result = await run.result
        expect(result).toMatchObject({
          stopReason: 'completed',
          output: [{ type: 'text', text: 'done' }],
        })
      }

      const [defaultRun, advancedRun] = runs
      if (defaultRun?.localAgent === undefined || advancedRun?.localAgent === undefined) {
        throw new Error('fixture providers did not publish local Agents')
      }
      expect(defaultRun.id).not.toBe(advancedRun.id)
      expect(defaultRun.localAgent.session.header.agentPreset).toBe('work-child')
      expect(advancedRun.localAgent.session.header.agentPreset).toBe('work-advanced')
      expect(defaultRun.localAgent.session.header.seedLength).toBe(0)
      expect(advancedRun.localAgent.session.header.seedLength).toBe(0)

      const selections = runs.map((run) => {
        const event = run.localAgent?.session.events.find(candidate => candidate.type === 'mistymoon:work-activation')
        if (event?.type !== 'mistymoon:work-activation') throw new Error('missing Work activation selection')
        return event.data
      })
      expect(selections.map(selection => selection.baselineFingerprint)).toEqual([
        baselineFingerprint,
        baselineFingerprint,
      ])
      expect(selections.map(selection => selection.nativePresetId)).toEqual([
        'work-child',
        'work-advanced',
      ])
      expect(runs.map(run => run.localAgent?.session.events.some(event => event.type === 'subagent/descriptor')))
        .toEqual([true, true])
      expect(adapter.requests.map(request => request.tools?.map(tool => tool.name))).toEqual([
        ['work_read'],
        ['work_complex'],
      ])
      expect(ctx.agentPresets.composedPreset(parent.agent.ctx)).toBe('rp-parent')
    } finally {
      for (const run of runs) await run.dispose()
      removeAdvanced()
      removeDefault()
      await parent.dispose()
      await ownerFiber.dispose()
    }
  })

  it('maps parent cancellation to aborted and disposes the published child idempotently', async () => {
    const adapter = new RecordingAdapter('hang')
    const { activationCtx, ctx, ownerFiber, parent } = await harness(adapter)
    const controller = new AbortController()
    const provider = createFixedWorkPresetProvider(activationCtx, {
      name: 'mistymoon-work-cancel-fixture',
      selection: {
        version: 1,
        nativePresetId: 'work-child',
        baselineFingerprint: 'd'.repeat(64),
        presetFingerprint: 'e'.repeat(64),
      },
      toolRestriction: { allow: ['work_read'] },
      validatePublication: () => 'valid',
    })
    const unregister = activationCtx.subagents.registerProvider(provider)
    let run: Awaited<ReturnType<typeof activationCtx.subagents.start>> | undefined

    try {
      run = await activationCtx.subagents.start(provider.name, {
        parent: parent.agent,
        prompt: [{ type: 'text', text: 'Wait for cancellation.' }],
        signal: controller.signal,
      })
      await adapter.waitForRequest()
      controller.abort(new Error('parent cancelled'))

      await expect(run.result).resolves.toMatchObject({
        stopReason: 'aborted',
        output: [],
      })
      const childId = run.id
      await run.dispose()
      await run.dispose()
      expect(ctx.agents.get(childId)).toBeUndefined()
      expect(ctx.sessions.get(childId)).toBeUndefined()
    } finally {
      await run?.dispose()
      unregister()
      await parent.dispose()
      await ownerFiber.dispose()
    }
  })
})

const DSH_COMPATIBILITY = {
  version: '0.1.0-rc.7',
  commit: '99f6f02fecdb7dff40c3fbc9470f5907c29f74ca',
} as const

const ANCHORED_UPSTREAM = {
  project: 'anchored-standard',
  commit: '25f21aefaf8ddc414da54d2e581e43740d977c6e',
  checksum: 'cefdb574edf0f160e97e46bbc4c891443e4978a5334455e19918543ea323c07a',
  checksumAlgorithm: 'sha256-git-ls-tree-v1',
  delivery: 'bundled',
  licenseStatus: 'ready',
  licenseSpdx: 'MIT',
  protectedSectionsCompatibility: 'requires-policy-shield',
} as const

function governedBaseline(): SharedBaselineDefinitionV1 {
  return {
    version: 1,
    generation: 'fixture-v1',
    dshCompatibility: DSH_COMPATIBILITY,
    ownerEligibilityPolicy: 'owner-eligibility-v1',
    protectedSections: ['dsh-safety', 'dsh-permission', 'dsh-agents'],
    workspacePolicy: 'parent-cwd-only',
    sandboxCeiling: 'workspace-write',
    approvalPolicy: 'never',
    maxDelegationDepth: 1,
    providerAllowlist: ['deepseek-official'],
    modelAllowlist: ['deepseek-v4-flash', 'deepseek-v4-pro'],
    rolePolicies: {
      rpHost: { toolAllow: [], toolDeny: ['work_read'] },
      workAgent: {
        toolAllow: ['work_read', 'work_complex'],
        toolDeny: ['mistymoon_memory', 'mistymoon_prepare_final_reply'],
      },
    },
    contractVersions: { delegation: 1, report: 1, handoff: 1 },
  }
}

function governedManifest(): WorkPresetManifestV1 {
  return {
    version: 1,
    preset: {
      version: 1,
      id: 'anchored-standard',
      nativePresetId: 'work-child',
      manifestFingerprint: '3'.repeat(64),
      upstreams: [ANCHORED_UPSTREAM],
    },
    dshCompatibility: DSH_COMPATIBILITY,
    compatibilityPatchVersion: 'work-compat-v1',
    licenseStatus: 'ready',
    activationStatus: 'default',
    requiredCapabilities: [],
  }
}

describe('createGovernedWorkPresetProvider', () => {
  it('binds resolver, baseline, compatibility, tool, and model-route decisions to publication', async () => {
    const { activationCtx, adapter, ownerFiber, parent } = await harness()
    const registry = new SharedBaselineRegistry()
    const manifest = governedManifest()
    const resolver = new WorkPresetResolver({
      dshCompatibility: DSH_COMPATIBILITY,
      manifests: [manifest],
      discovery: [{
        nativePresetId: manifest.preset.nativePresetId,
        manifestFingerprint: manifest.preset.manifestFingerprint,
        upstreams: manifest.preset.upstreams,
        immutableProvision: true,
        capabilities: [],
      }],
    })
    const resolvePublication = () => {
      const baseline = registry.resolve(governedBaseline())
      const preset = resolver.resolve('anchored-standard')
      const target: WorkActivationPolicyV1 = {
        version: 1,
        baselineFingerprint: baseline.fingerprint,
        preset,
        route: {
          id: 'flash-max',
          provider: 'deepseek-official',
          model: 'deepseek-v4-flash',
          reasoning: 'max',
        },
        toolCatalog: ['work_read'],
        sandbox: 'workspace-write',
        approval: 'never',
        delegationDepth: 1,
        prompt: {
          persona: 'neutral-work',
          runtimeContext: 'preserve',
          sectionPolicy: 'preserve',
          protectedSections: baseline.protectedSections,
        },
      }
      return prepareWorkActivationPublication({ baseline, target })
    }
    const provider = createGovernedWorkPresetProvider(activationCtx, {
      name: 'mistymoon-governed-work-fixture',
      resolvePublication,
      activation: {
        logicalAgentId: 'mistymoon-work-fixture',
        profileRevision: 3,
        profileId: 'anchored-standard',
      },
    })
    const unregister = activationCtx.subagents.registerProvider(provider)
    let run: Awaited<ReturnType<typeof activationCtx.subagents.start>> | undefined

    try {
      run = await activationCtx.subagents.start(provider.name, {
        parent: parent.agent,
        prompt: [{ type: 'text', text: 'Run the governed Work activation.' }],
        signal: new AbortController().signal,
        agentOptions: {
          provider: 'deepseek-official',
          model: 'deepseek-v4-flash',
        },
      })
      await expect(run.result).resolves.toMatchObject({ stopReason: 'completed' })

      expect(adapter.requests).toHaveLength(1)
      expect(adapter.requests[0]).toMatchObject({
        provider: 'deepseek-official',
        model: 'deepseek-v4-flash',
        reasoningEffort: 'max',
      })
      expect(adapter.requests[0]?.tools?.map(tool => tool.name)).toEqual(['work_read'])
      expect(run.localAgent?.session.requestHeader()).toMatchObject({
        config: {
          provider: 'deepseek-official',
          model: 'deepseek-v4-flash',
          reasoningEffort: 'max',
        },
      })
      const activation = run.localAgent?.session.events.find(
        event => event.type === 'mistymoon:work-activation',
      )
      expect(activation?.data).toMatchObject({
        provider: provider.name,
        nativePresetId: 'work-child',
        baselineFingerprint: resolvePublication().baselineFingerprint,
        presetFingerprint: manifest.preset.manifestFingerprint,
        logicalAgentId: 'mistymoon-work-fixture',
        profileRevision: 3,
        profileId: 'anchored-standard',
      })
    } finally {
      await run?.dispose()
      unregister()
      await parent.dispose()
      await ownerFiber.dispose()
    }
  })

  it('rolls back when a compatible governed selection changes before publication', async () => {
    const { activationCtx, ctx, ownerFiber, parent } = await harness()
    const registry = new SharedBaselineRegistry()
    const manifest = governedManifest()
    const resolver = new WorkPresetResolver({
      dshCompatibility: DSH_COMPATIBILITY,
      manifests: [manifest],
      discovery: [{
        nativePresetId: manifest.preset.nativePresetId,
        manifestFingerprint: manifest.preset.manifestFingerprint,
        upstreams: manifest.preset.upstreams,
        immutableProvision: true,
        capabilities: [],
      }],
    })
    let route: WorkActivationPolicyV1['route'] = {
      id: 'flash-max',
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
      reasoning: 'max',
    }
    const resolvePublication = () => {
      const baseline = registry.resolve(governedBaseline())
      return prepareWorkActivationPublication({
        baseline,
        target: {
          version: 1,
          baselineFingerprint: baseline.fingerprint,
          preset: resolver.resolve('anchored-standard'),
          route,
          toolCatalog: ['work_read'],
          sandbox: 'workspace-write',
          approval: 'never',
          delegationDepth: 1,
          prompt: {
            persona: 'neutral-work',
            runtimeContext: 'preserve',
            sectionPolicy: 'preserve',
            protectedSections: baseline.protectedSections,
          },
        },
      })
    }
    const provider = createGovernedWorkPresetProvider(activationCtx, {
      name: 'mistymoon-stale-governance-fixture',
      resolvePublication,
    })
    const unregister = activationCtx.subagents.registerProvider(provider)
    route = {
      id: 'pro-max',
      provider: 'deepseek-official',
      model: 'deepseek-v4-pro',
      reasoning: 'max',
    }

    try {
      await expect(activationCtx.subagents.start(provider.name, {
        parent: parent.agent,
        prompt: [{ type: 'text', text: 'This stale activation must not run.' }],
        signal: new AbortController().signal,
      })).rejects.toBeInstanceOf(StaleWorkActivationPublicationError)
      expect(ctx.agents.list()).toEqual([parent.agent])
      expect(ctx.sessions.list()).toEqual([parent.agent.session])
    } finally {
      unregister()
      await parent.dispose()
      await ownerFiber.dispose()
    }
  })
})
