import { lstat, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
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
import { resolveSessionPreset } from '@deepseek-ai/dsh-agent-presets'
import { SessionId } from '@deepseek-ai/dsh-session'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import {
  FINAL_REPLY_TOOL,
  PublishedPersonaProjection,
  RoleplayController,
} from '@mistymoon/dsh/foundation'
import {
  applyMistyMoonInstallation,
  packProfileBundle,
  previewMistyMoonInstallation,
} from '@mistymoon/dsh-installer'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { FLASH_PROVIDER_NAME, RpWorkDelegationRuntime } from '../src/index.js'

const require = createRequire(import.meta.url)
const DSH_PACKAGE_MANIFEST = require.resolve('@deepseek-ai/dsh/package.json')
const DSH_PACKAGE_ROOT = dirname(DSH_PACKAGE_MANIFEST)
const SHIPPED_PRESET_ROOT = join(DSH_PACKAGE_ROOT, 'config', 'agent-presets')
const WORKSPACE_ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const RP_PRESET_ID = 'mistymoon-rp-host-v2'
const INITIAL_PRESET_ID = 'code'
let packedBundleRoot: string
let packedBundlePath: string

beforeAll(async () => {
  packedBundleRoot = await mkdtemp(join(tmpdir(), 'mistymoon-rp-host-bundle-'))
  packedBundlePath = await packProfileBundle({
    workspaceRoot: WORKSPACE_ROOT,
    outputPath: join(packedBundleRoot, 'mistymoon-dsh.tgz'),
  })
}, 180_000)

afterAll(async () => {
  await rm(packedBundleRoot, { recursive: true, force: true })
})

const PERSONA = {
  schemaVersion: 2,
  kind: 'mistymoon.persona',
  displayName: 'Nova',
  identity: {
    summary: 'Nova is a neutral fixture companion.',
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
  referenceDialogs: [],
  responseBudgets: {
    brief: { targetCharacters: 40, maxOutputTokens: 100 },
    normal: { targetCharacters: 200, maxOutputTokens: 500 },
    deep: { targetCharacters: 800, maxOutputTokens: 1600 },
  },
  boundaries: { privateByDefault: true, requireApprovalForExternalActions: true },
} as const

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
    const text = options.provider === 'deepseek-official'
      ? JSON.stringify({
          version: 1,
          status: 'completed',
          summary: 'Inspected the neutral delegated fixture.',
          changedFiles: [],
          checksRun: [],
          risks: [],
          needsUserAction: [],
          artifacts: [],
        })
      : 'Direct neutral companion reply.'
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield {
      type: 'block-end',
      index: 0,
      block: { type: 'text', text },
    }
    yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

async function bootHeadlessHarness(dshHome: string) {
  const profileDir = resolveProfileDir('headless', dshHome)
  initProfile(profileDir, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless'])
  healProfilesModuleFallback(DSH_PACKAGE_MANIFEST, dshHome)
  const mistymoonLinkParent = join(profileDir, 'node_modules', '@mistymoon')
  await mkdir(mistymoonLinkParent, { recursive: true })
  const mistymoonLink = join(mistymoonLinkParent, 'dsh')
  if (await lstat(mistymoonLink).then(() => false, () => true)) {
    await symlink(WORKSPACE_ROOT, mistymoonLink, 'junction')
  }
  const profile = loadProfile('mistymoon-rp-headless-test', 'headless', DSH_PACKAGE_MANIFEST, dshHome)
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
  return boot(
    'mistymoon-rp-headless-test',
    emptyComposition,
    patches,
    undefined,
    pathToFileURL(DSH_PACKAGE_ROOT).href,
  )
}

async function disposeContext(ctx: Awaited<ReturnType<typeof bootHeadlessHarness>> | undefined): Promise<void> {
  await (ctx as (typeof ctx & { fiber?: { dispose(): Promise<void> | void } }))?.fiber?.dispose()
}

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('RP Host preset through a restarted headless DSH runtime', () => {
  it('provisions, selects after blank-session creation, and records the Persona system surface without legacy delivery', async () => {
    const dshHome = await mkdtemp(join(tmpdir(), 'mistymoon-rp-host-headless-'))
    vi.stubEnv('DSH_HOME', dshHome)
    const personaPath = join(dshHome, 'mistymoon-fixture', 'persona.json')
    await mkdir(dirname(personaPath), { recursive: true })
    await writeFile(personaPath, `${JSON.stringify(PERSONA)}\n`, 'utf8')
    let discoveryCtx: Awaited<ReturnType<typeof bootHeadlessHarness>> | undefined
    let runtimeCtx: Awaited<ReturnType<typeof bootHeadlessHarness>> | undefined
    let ownerFiber: Awaited<ReturnType<Awaited<ReturnType<typeof bootHeadlessHarness>>['inject']>> | undefined
    let handle: Awaited<ReturnType<Awaited<ReturnType<typeof bootHeadlessHarness>>['agents']['create']>> | undefined
    let workRun: Awaited<ReturnType<Awaited<ReturnType<typeof bootHeadlessHarness>>['subagents']['start']>> | undefined
    const unregisterProviders: Array<() => void> = []

    try {
      discoveryCtx = await bootHeadlessHarness(dshHome)
      expect((await discoveryCtx.agentPresets.list()).map(preset => preset.id)).not.toContain(RP_PRESET_ID)
      await disposeContext(discoveryCtx)
      discoveryCtx = undefined

      const plan = await previewMistyMoonInstallation({
        packageRoot: WORKSPACE_ROOT,
        dshRuntimeRoot: WORKSPACE_ROOT,
        dshHome,
        bundleArchivePath: packedBundlePath,
      })
      expect(plan.status).toBe('ready')
      await applyMistyMoonInstallation(plan, { ownerConfirmed: true })

      runtimeCtx = await bootHeadlessHarness(dshHome)
      const discovered = await runtimeCtx.agentPresets.resolve(RP_PRESET_ID)
      expect(discovered).toMatchObject({
        id: RP_PRESET_ID,
        trust: 'user',
      })
      expect(discovered.broken).toBeUndefined()
      const discoveredWork = await runtimeCtx.agentPresets.resolve('mistymoon-work-anchored-standard-v2')
      expect(discoveredWork).toMatchObject({
        id: 'mistymoon-work-anchored-standard-v2',
        trust: 'user',
      })
      expect(discoveredWork.broken).toBeUndefined()
      const projection = await PublishedPersonaProjection.load(personaPath)
      runtimeCtx.effect(() => runtimeCtx!.provide('mistymoonPersonaProjection', projection))
      runtimeCtx.effect(() => runtimeCtx!.provide('mistymoonRoleplay', new RoleplayController('immersive')))
      runtimeCtx.tools.register(defineContentToolFixture({
        name: FINAL_REPLY_TOOL,
        description: 'legacy fixture finalization tool',
        parameters: {},
        async execute() { return [{ type: 'text', text: 'legacy' }] },
      }))
      const adapter = new RecordingAdapter()
      const unregisterAdapter = runtimeCtx.llm.registerAdapter(['mock', 'deepseek-official'], adapter)
      const workRuntime = new RpWorkDelegationRuntime(runtimeCtx)
      for (const provider of workRuntime.providers()) {
        unregisterProviders.push(runtimeCtx.subagents.registerProvider(provider))
      }

      let handlePromise: ReturnType<typeof runtimeCtx.agents.create> | undefined
      ownerFiber = runtimeCtx.inject(['agents', 'agentPresets'], (injectedCtx) => {
        handlePromise = injectedCtx.agents.create({
          sessionId: SessionId(`rp-host-${crypto.randomUUID()}`),
          meta: { agentPreset: INITIAL_PRESET_ID, cwd: process.cwd() },
          agentOptions: { provider: 'mock', model: 'ui-selected-model' },
          async setup(agentCtx) {
            await injectedCtx.agentPresets.mount(agentCtx, INITIAL_PRESET_ID)
          },
        })
      })
      await ownerFiber
      if (handlePromise === undefined) throw new Error('RP Host activation context did not start')
      handle = await handlePromise
      expect(handle.agent.session.header.agentPreset).toBe(INITIAL_PRESET_ID)
      const selected = await runtimeCtx.agentPresets.recompose(handle.agent.ctx, RP_PRESET_ID)
      handle.agent.session.append('agent-preset/selected', { agentPreset: selected.id })
      handle.agent.followup(createUserMessage({
        content: [{ type: 'text', text: 'Give a neutral direct reply.' }],
        source: { kind: 'user' },
      }))
      await handle.agent.whenIdle()
      expect(resolveSessionPreset(handle.agent.session)).toBe(RP_PRESET_ID)
      expect(runtimeCtx.agentPresets.composedPreset(handle.agent.ctx)).toBe(RP_PRESET_ID)

      const assembly = await handle.agent.ctx.systemPrompt.assemble(assembleContextFor(handle.agent))
      const toolNames = assembly.tools.map(tool => tool.name)
      expect(assembly.sections.find(section => section.name === 'deployment:persona')?.text)
        .toContain('You are Nova.')
      expect(assembly.sections.map(section => section.name)).not.toContain('harness:identity')
      expect(assembly.sections.map(section => section.name)).toContain('tool:write')
      expect(toolNames).toEqual(expect.arrayContaining([
        'web_search',
        'web_fetch',
        'read',
        'grep',
        'glob',
        'mistymoon_code_flash',
      ]))
      expect(toolNames).not.toContain('mistymoon_code_pro')
      expect(toolNames).not.toContain(FINAL_REPLY_TOOL)
      expect(toolNames).not.toEqual(expect.arrayContaining(['pwsh', 'write', 'edit', 'subagent']))
      const ownerRequests = adapter.requests.filter(request => request.messages
        .some(message => message.source.kind === 'user'))
      expect(ownerRequests).toHaveLength(1)
      expect(ownerRequests[0]).toMatchObject({
        provider: 'mock',
        model: 'ui-selected-model',
      })
      expect(ownerRequests[0]?.system).toContain('You are Nova.')
      expect(ownerRequests[0]?.system)
        .not.toContain('You are an AI agent powered by DeepSeek Harness.')
      expect(ownerRequests[0]?.messages).not.toEqual(expect.arrayContaining([
        expect.objectContaining({
          content: expect.arrayContaining([
            expect.objectContaining({
              type: 'text',
              text: expect.stringContaining('MistyMoon output presentation profile'),
            }),
          ]),
        }),
      ]))
      expect(handle.agent.session.requestHeader()).toMatchObject({
        system: expect.stringContaining('You are Nova.'),
        config: {
          provider: 'mock',
          model: 'ui-selected-model',
        },
      })
      expect(handle.agent.session.events.some(event => event.type === 'assistant/message'
        && event.data.message.content.some(block => block.type === 'text'
          && block.text === 'Direct neutral companion reply.'))).toBe(true)

      workRun = await runtimeCtx.subagents.start(FLASH_PROVIDER_NAME, {
        parent: handle.agent,
        prompt: [{ type: 'text', text: 'Inspect the neutral delegated fixture.' }],
        signal: new AbortController().signal,
      })
      await expect(workRun.result).resolves.toMatchObject({
        stopReason: 'completed',
        structured: {
          version: 1,
          summary: 'Inspected the neutral delegated fixture.',
        },
      })
      expect(workRun.localAgent?.session.header).toMatchObject({
        parentSession: handle.agent.session.id,
        agentPreset: 'mistymoon-work-anchored-standard-v2',
      })
      unregisterAdapter()
    } finally {
      await workRun?.dispose()
      await handle?.dispose()
      for (const unregister of unregisterProviders.reverse()) unregister()
      await ownerFiber?.dispose()
      await disposeContext(runtimeCtx)
      await disposeContext(discoveryCtx)
      await rm(dshHome, { recursive: true, force: true })
    }
  }, 240_000)
})
