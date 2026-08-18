import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { assembleContextFor } from '@deepseek-ai/dsh-agent'
import {
  boot,
  healProfilesModuleFallback,
  initProfile,
  loadProfile,
  resolveProfileDir,
} from '@deepseek-ai/dsh-app-boot'
import {
  createUserMessage,
  LlmAdapter,
  ReasoningEffortId,
  type GenerateOptions,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  applyWorkPresetProvision,
  previewWorkPresetProvision,
} from '@mistymoon/dsh-installer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createFreshWorkActivation,
  FLASH_PROVIDER_NAME,
  RP_HOST_PRESET_ID,
  RpWorkDelegationRuntime,
} from '../src/index.js'

const require = createRequire(import.meta.url)
const DSH_PACKAGE_MANIFEST = require.resolve('@deepseek-ai/dsh/package.json')
const DSH_PACKAGE_ROOT = dirname(DSH_PACKAGE_MANIFEST)
const SHIPPED_PRESET_ROOT = join(DSH_PACKAGE_ROOT, 'config', 'agent-presets')
const ANCHORED_STANDARD_SOURCE = fileURLToPath(new URL(
  '../../work-agent/presets/mistymoon-work-anchored-standard-v1',
  import.meta.url,
))
const ANCHORED_STANDARD_PRESET_ID = 'mistymoon-work-anchored-standard-v1'

class RecordingAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

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
    const requiresWorkReport = options.messages.some(message => message.content.some(block => block.type === 'text'
      && block.text.includes('WorkReportV1')))
    const output = requiresWorkReport
      ? JSON.stringify({
          version: 1,
          status: 'completed',
          summary: 'Inspected the neutral product provider fixture.',
          changedFiles: [],
          checksRun: [],
          risks: [],
          needsUserAction: [],
          artifacts: [],
        })
      : 'done'
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: output }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: output } }
    yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

async function bootHeadlessHarness(dshHome: string, adapter: RecordingAdapter) {
  const profileDir = resolveProfileDir('headless', dshHome)
  initProfile(profileDir, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless'])
  healProfilesModuleFallback(DSH_PACKAGE_MANIFEST, dshHome)
  const profile = loadProfile('mistymoon-headless-test', 'headless', DSH_PACKAGE_MANIFEST, dshHome)
  const emptyComposition = join(profileDir, 'mistymoon-test-root.cordis.yml')
  await writeFile(emptyComposition, '[]\n', 'utf8')
  const patches = [
    ...profile.layers.flatMap(layer => layer.patches),
    ...profile.patches,
    { id: 'headless-startup', disabled: true },
    { id: 'headless-runner', disabled: true },
    { id: 'code-runtime', disabled: true },
    { id: 'llm-deepseek', disabled: true },
    {
      insert: [{
        id: 'agent-presets',
        name: '@deepseek-ai/dsh-agent-presets',
        config: {
          default: 'code',
          roots: [{ path: SHIPPED_PRESET_ROOT, trust: 'system' }],
          includeUserRoot: true,
        },
      }],
    },
  ]
  const ctx = await boot(
    'mistymoon-headless-test',
    emptyComposition,
    patches,
    undefined,
    pathToFileURL(DSH_PACKAGE_ROOT).href,
  )
  ctx.llm.registerAdapter(['mock', 'deepseek-official'], adapter)
  return ctx
}

async function disposeContext(ctx: Awaited<ReturnType<typeof bootHeadlessHarness>> | undefined): Promise<void> {
  await (ctx as (typeof ctx & { fiber?: { dispose(): Promise<void> | void } }))?.fiber?.dispose()
}

function messageText(message: GenerateOptions['messages'][number]): string {
  return message.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('\n')
}

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('Anchored preset provision through a restarted headless DSH runtime', () => {
  it('discovers, mounts, captures, and rolls back through public seams', async () => {
    const dshHome = await mkdtemp(join(tmpdir(), 'mistymoon-anchored-headless-'))
    vi.stubEnv('DSH_HOME', dshHome)
    vi.stubEnv('DSH_PERMISSION_MODE', 'workspace-write')
    let discoveryCtx: Awaited<ReturnType<typeof bootHeadlessHarness>> | undefined
    let runtimeCtx: Awaited<ReturnType<typeof bootHeadlessHarness>> | undefined
    let ownerFiber: Awaited<ReturnType<Awaited<ReturnType<typeof bootHeadlessHarness>>['inject']>> | undefined
    let parent: Awaited<ReturnType<Awaited<ReturnType<typeof bootHeadlessHarness>>['agents']['create']>> | undefined
    let child: Awaited<ReturnType<typeof createFreshWorkActivation>> | undefined
    let rpParent: typeof parent
    let productRun: Awaited<ReturnType<Awaited<ReturnType<typeof bootHeadlessHarness>>['subagents']['start']>> | undefined
    const unregisterProviders: Array<() => void> = []

    try {
      discoveryCtx = await bootHeadlessHarness(dshHome, new RecordingAdapter())
      expect((await discoveryCtx.agentPresets.list()).map(preset => preset.id))
        .not.toContain(ANCHORED_STANDARD_PRESET_ID)
      await disposeContext(discoveryCtx)
      discoveryCtx = undefined

      const plan = await previewWorkPresetProvision({
        version: 1,
        action: 'install',
        dshHome,
        sourceDirectory: ANCHORED_STANDARD_SOURCE,
        nativePresetId: ANCHORED_STANDARD_PRESET_ID,
      })
      expect(plan.status).toBe('ready')
      expect(plan.sourceFingerprint)
        .toBe('c32cf15b81e38de65325c99e9296ea116a9b6d414111732d0ef0d36c3138aa5e')
      await applyWorkPresetProvision(plan, { ownerConfirmed: true })

      const adapter = new RecordingAdapter()
      runtimeCtx = await bootHeadlessHarness(dshHome, adapter)
      const discovered = await runtimeCtx.agentPresets.resolve(ANCHORED_STANDARD_PRESET_ID)
      expect(discovered).toMatchObject({
        id: ANCHORED_STANDARD_PRESET_ID,
        trust: 'user',
      })
      expect(discovered.broken).toBeUndefined()

      let activationCtx: typeof runtimeCtx | undefined
      let parentPromise: ReturnType<typeof runtimeCtx.agents.create> | undefined
      ownerFiber = runtimeCtx.inject(['agents', 'agentPresets', 'subagents'], (injectedCtx) => {
        activationCtx = injectedCtx
        parentPromise = injectedCtx.agents.create({
          sessionId: SessionId(`rp-parent-${crypto.randomUUID()}`),
          meta: { agentPreset: 'code', cwd: process.cwd() },
          agentOptions: { provider: 'mock', model: 'parent-model' },
          async setup(agentCtx) {
            await injectedCtx.agentPresets.mount(agentCtx, 'code')
          },
        })
      })
      await ownerFiber
      if (activationCtx === undefined || parentPromise === undefined) {
        throw new Error('headless activation context did not start')
      }
      parent = await parentPromise

      const rolledBackId = SessionId(`anchored-rollback-${crypto.randomUUID()}`)
      await expect(createFreshWorkActivation(activationCtx, {
        parent: parent.agent,
        childSessionId: rolledBackId,
        nativePresetId: ANCHORED_STANDARD_PRESET_ID,
        agentOptions: { provider: 'mock', model: 'work-model' },
        signal: new AbortController().signal,
        validatePublication() {
          throw new Error('publication rejected after real Anchored mount')
        },
      })).rejects.toThrow('publication rejected after real Anchored mount')
      expect(runtimeCtx.agents.get(rolledBackId)).toBeUndefined()
      expect(runtimeCtx.sessions.get(rolledBackId)).toBeUndefined()

      const childId = SessionId(`anchored-child-${crypto.randomUUID()}`)
      child = await createFreshWorkActivation(activationCtx, {
        parent: parent.agent,
        childSessionId: childId,
        nativePresetId: ANCHORED_STANDARD_PRESET_ID,
        agentOptions: { provider: 'mock', model: 'work-model' },
        signal: new AbortController().signal,
        validatePublication: () => 'valid',
      })

      const assembly = await child.agent.ctx.systemPrompt.assemble(assembleContextFor(child.agent))
      expect(assembly.sections.map(section => section.name)).toEqual(expect.arrayContaining([
        'harness:identity',
        'deployment:persona',
      ]))
      expect(assembly.sections.find(section => section.name === 'deployment:persona')?.text)
        .toBe('You are a helpful software engineer assistant.')
      expect(assembly.sections.map(section => section.name)).not.toContain('router-persona')
      expect(assembly.contexts.map(context => context.name)).toContain('sandbox:policy')
      expect(assembly.tools.map(tool => tool.name)).toEqual(['bash', 'str_replace_editor'])

      child.agent.followup(createUserMessage({
        content: [{ type: 'text', text: 'Examine the parser behavior in the neutral Anchored sample.' }],
        source: { kind: 'user' },
      }))
      await child.agent.whenIdle()

      expect(adapter.requests).toHaveLength(1)
      const request = adapter.requests[0]
      expect(request?.system).toContain('You are an AI agent powered by DeepSeek Harness.')
      expect(request?.system).toContain('You are a helpful software engineer assistant.')
      expect(request?.tools?.map(tool => tool.name)).toEqual(['bash', 'str_replace_editor'])
      expect(request?.messages.some(message => String(message.source.kind) === 'agent-instructions')).toBe(true)
      expect(request?.messages.map(messageText).join('\n'))
        .toContain('Current DSH file policy: workspace-write.')
      expect(request?.messages.map(messageText).join('\n')).not.toContain('Router:')
      expect(child.agent.session.requestHeader()).toMatchObject({
        config: { provider: 'mock', model: 'work-model' },
        tools: [
          expect.objectContaining({ name: 'bash' }),
          expect.objectContaining({ name: 'str_replace_editor' }),
        ],
      })
      expect(runtimeCtx.agentPresets.composedPreset(parent.agent.ctx)).toBe('code')
      expect(runtimeCtx.agentPresets.composedPreset(child.agent.ctx)).toBe(ANCHORED_STANDARD_PRESET_ID)

      rpParent = await activationCtx.agents.create({
        sessionId: SessionId(`product-rp-parent-${crypto.randomUUID()}`),
        meta: { agentPreset: RP_HOST_PRESET_ID, cwd: process.cwd() },
        agentOptions: { provider: 'mock', model: 'parent-model' },
        async setup(agentCtx) {
          await activationCtx!.agentPresets.mount(agentCtx, 'code')
        },
      })
      const product = new RpWorkDelegationRuntime(activationCtx)
      for (const provider of product.providers()) {
        unregisterProviders.push(activationCtx.subagents.registerProvider(provider))
      }
      productRun = await activationCtx.subagents.start(FLASH_PROVIDER_NAME, {
        parent: rpParent.agent,
        prompt: [{ type: 'text', text: 'Inspect the neutral product provider fixture.' }],
        signal: new AbortController().signal,
      })
      await expect(productRun.result).resolves.toMatchObject({ stopReason: 'completed' })
      await expect(activationCtx.subagents.listChildren(rpParent.agent.session.id)).resolves.toEqual([
        expect.objectContaining({
          kind: 'child',
          id: productRun.id,
          mode: 'one-shot',
        }),
      ])
      expect(adapter.requests.at(-1)).toMatchObject({
        provider: 'deepseek-official',
        model: 'deepseek-v4-flash',
        reasoningEffort: 'max',
      })
      expect(adapter.requests.at(-1)?.tools?.map(tool => tool.name))
        .toEqual(['bash', 'str_replace_editor'])
      const promoted = await productRun.localAgent!.ctx.systemPrompt.assemble(
        assembleContextFor(productRun.localAgent!),
      )
      expect(promoted.tools.map(tool => tool.name)).toEqual([
        'bash',
        'dev_tool_search',
        'skill_load',
        'skill_search',
        'str_replace_editor',
      ])
      expect(promoted.tools.map(tool => tool.name)).not.toEqual(expect.arrayContaining([
        'mistymoon_prepare_final_reply',
        'memory_list',
        'subagent',
        'subagent_fork',
        'list_agents',
        'send_message',
        'interrupt_agent',
        'workflow',
        'ralph',
      ]))
      expect(productRun.localAgent?.session.header).toMatchObject({
        agentPreset: ANCHORED_STANDARD_PRESET_ID,
        delegationDepth: 1,
        seedLength: 0,
      })
      expect(productRun.localAgent?.session.events.find(event => event.type === 'mistymoon:work-activation')?.data)
        .toMatchObject({
          logicalAgentId: 'mistymoon-work-v1',
          profileRevision: 1,
          profileId: 'anchored-standard',
        })
    } finally {
      await productRun?.dispose()
      for (const unregister of unregisterProviders.reverse()) unregister()
      await rpParent?.dispose()
      await child?.dispose()
      await parent?.dispose()
      await ownerFiber?.dispose()
      await disposeContext(runtimeCtx)
      await disposeContext(discoveryCtx)
      await rm(dshHome, { recursive: true, force: true })
    }
  }, 120_000)
})
