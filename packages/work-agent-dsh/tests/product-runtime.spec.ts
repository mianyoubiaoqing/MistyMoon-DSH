import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import {
  FLASH_PROVIDER_NAME,
  RP_HOST_PRESET_ID,
  RpWorkDelegationRuntime,
  WorkActivationRoleError,
} from '../src/index.js'

function host(id = 'rp-host', preset = RP_HOST_PRESET_ID): Agent {
  const sessionId = SessionId(id)
  const session = Session.create(sessionId, [], {
    version: 0,
    id: sessionId,
    createdAt: 1,
    delegationDepth: 0,
    agentPreset: preset,
  })
  return { id: sessionId, session } as unknown as Agent
}

describe('RP Work product runtime', () => {
  it('publishes only the qualified Flash foreground provider and an Anchored-only neutral surface', () => {
    const runtime = new RpWorkDelegationRuntime({} as Context)
    const parent = host()

    expect(runtime.providers().map(provider => provider.name)).toEqual([FLASH_PROVIDER_NAME])
    expect(runtime.providers().every(provider => provider.inheritsParentContext === false)).toBe(true)
    expect(runtime.selection(parent)).toEqual({
      version: 1,
      revision: 1,
      profile: 'anchored-standard',
    })
    expect(runtime.publication(parent)).toMatchObject({
      version: 1,
      presetId: 'anchored-standard',
      nativePresetId: 'mistymoon-work-anchored-standard-v1',
      route: {
        provider: 'deepseek-official',
        model: 'deepseek-v4-flash',
        reasoning: 'max',
      },
      effectiveTools: expect.arrayContaining(['bash', 'str_replace_editor']),
    })
    expect(runtime.publication(parent).effectiveTools).not.toEqual(expect.arrayContaining([
      'mistymoon_prepare_final_reply',
      'memory_list',
      'subagent',
      'workflow',
    ]))
  })

  it('commits a J-Space selection only for the next fresh activation when explicitly enabled', () => {
    const runtime = new RpWorkDelegationRuntime({} as Context, { enableJSpace: true })
    const parent = host('switch-host')
    const frozenBefore = runtime.publication(parent)
    const result = runtime.switchProfile(parent, {
      version: 1,
      requestId: 'owner-switch-1',
      expectedRevision: 1,
      targetProfile: 'anchored-standard-jspace',
      reason: 'Use the qualified complex-task profile.',
      ownerConfirmed: true,
    })

    expect(result).toMatchObject({ status: 'committed', selection: { revision: 2 } })
    expect(frozenBefore.presetId).toBe('anchored-standard')
    expect(runtime.publication(parent)).toMatchObject({
      presetId: 'anchored-standard-jspace',
      nativePresetId: 'mistymoon-work-anchored-standard-jspace-v1',
      route: {
        provider: 'deepseek-official',
        model: 'deepseek-v4-flash',
        reasoning: 'max',
      },
    })
    expect(parent.session.events.filter(event => event.type === 'mistymoon:work-profile-switched'))
      .toHaveLength(1)
  })

  it('configures a live DSH catalog model only for future fresh activations', async () => {
    const ctx = {
      llm: {
        listProviders: () => [
          { id: 'deepseek-official', name: 'DeepSeek' },
          { id: 'opencode-go', name: 'OpenCode Go' },
        ],
        listModels: async (provider: string) => provider === 'opencode-go'
          ? [{ provider, id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' }]
          : [{ provider, id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' }],
        resolveCallConfig: async (config: unknown) => config,
      },
    } as unknown as Context
    const runtime = new RpWorkDelegationRuntime(ctx)
    const parent = host('go-route-host')
    const frozenBefore = runtime.publication(parent)

    await expect(runtime.configureModelRoute({
      version: 1,
      expectedRevision: 1,
      provider: 'opencode-go',
      model: 'deepseek-v4-flash',
      ownerConfirmed: false,
    })).rejects.toThrow(/require Owner confirmation/)

    await expect(runtime.configureModelRoute({
      version: 1,
      expectedRevision: 1,
      provider: 'opencode-go',
      model: 'deepseek-v4-flash',
      ownerConfirmed: true,
    })).resolves.toMatchObject({ revision: 2, qualification: 'experimental-owner-configured' })
    expect(frozenBefore.route).toMatchObject({
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
    })
    expect(runtime.publication(parent).route).toMatchObject({
      id: expect.stringMatching(/^configured-[0-9a-f]{64}$/),
      provider: 'opencode-go',
      model: 'deepseek-v4-flash',
      reasoning: 'max',
    })
  })

  it('keeps the current model revision when the Owner saves the same exact route', async () => {
    const ctx = {
      llm: {
        listProviders: () => [{ id: 'deepseek-official', name: 'DeepSeek' }],
        listModels: async () => [{
          provider: 'deepseek-official',
          id: 'deepseek-v4-flash',
          name: 'DeepSeek V4 Flash',
        }],
        resolveCallConfig: async (config: unknown) => config,
      },
    } as unknown as Context
    const runtime = new RpWorkDelegationRuntime(ctx)

    await expect(runtime.configureModelRoute({
      version: 1,
      expectedRevision: 1,
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
      ownerConfirmed: false,
    })).resolves.toEqual(runtime.modelSettings())
    expect(runtime.modelSettings().revision).toBe(1)
  })

  it('fails closed for unavailable J-Space and non-RP parents', () => {
    const runtime = new RpWorkDelegationRuntime({} as Context)
    const parent = host('default-host')

    expect(runtime.switchProfile(parent, {
      version: 1,
      requestId: 'owner-switch-2',
      expectedRevision: 1,
      targetProfile: 'anchored-standard-jspace',
      reason: 'Unavailable experiment.',
      ownerConfirmed: true,
    })).toMatchObject({ status: 'not-ready' })
    expect(() => runtime.selection(host('general-host', 'standard')))
      .toThrow(WorkActivationRoleError)
  })
})
