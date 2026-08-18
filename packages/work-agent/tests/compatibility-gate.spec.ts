import { describe, expect, it } from 'vitest'
import {
  CompatibilityGate,
  configuredWorkRouteId,
  prepareWorkActivationPublication,
  type ResolvedWorkPresetV1,
  type SharedBaselineDefinitionV1,
  SharedBaselineRegistry,
  type WorkActivationPolicyV1,
  WorkActivationPublicationError,
} from '../src/index.js'

function baselineDefinition(
  overrides: Partial<SharedBaselineDefinitionV1> = {},
): SharedBaselineDefinitionV1 {
  return {
    version: 1,
    generation: 'baseline-2026-08-17.1',
    dshCompatibility: {
      version: '0.1.0-rc.7',
      commit: '99f6f02fecdb7dff40c3fbc9470f5907c29f74ca',
    },
    ownerEligibilityPolicy: 'mistymoon-owner-eligibility-v1',
    protectedSections: ['dsh-safety', 'permissions', 'plan', 'agents', 'skills'],
    workspacePolicy: 'parent-cwd-only',
    sandboxCeiling: 'workspace-write',
    approvalPolicy: 'never',
    maxDelegationDepth: 1,
    providerAllowlist: ['deepseek-official'],
    modelAllowlist: ['deepseek-v4-flash', 'deepseek-v4-pro'],
    rolePolicies: {
      rpHost: {
        toolAllow: ['mistymoon_delegate_work'],
        toolDeny: ['shell_command', 'apply_patch'],
      },
      workAgent: {
        toolAllow: ['shell_command', 'apply_patch', 'fs_search', 'jspace_ledger'],
        toolDeny: [
          'mistymoon_prepare_final_reply',
          'mistymoon_memory_write',
          'mistymoon_delegate_work',
          'git_push',
          'release',
        ],
      },
    },
    contractVersions: { delegation: 1, report: 1, handoff: 1 },
    ...overrides,
  }
}

function preset(
  id: 'anchored-standard' | 'anchored-standard-jspace' = 'anchored-standard',
): ResolvedWorkPresetV1 {
  return {
    version: 1,
    id,
    nativePresetId: `mistymoon-work-${id}-v1`,
    manifestFingerprint: 'd'.repeat(64),
    upstreams: [],
    compatibilityPatchVersion: 'mistymoon-work-adapter-v1',
  }
}

function target(
  overrides: Partial<WorkActivationPolicyV1> = {},
): WorkActivationPolicyV1 {
  const baseline = new SharedBaselineRegistry().resolve(baselineDefinition())
  return {
    version: 1,
    baselineFingerprint: baseline.fingerprint,
    preset: preset(),
    route: {
      id: 'flash-max',
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
      reasoning: 'max',
    },
    toolCatalog: ['shell_command', 'apply_patch', 'fs_search'],
    sandbox: 'workspace-write',
    approval: 'never',
    delegationDepth: 1,
    prompt: {
      persona: 'neutral-work',
      runtimeContext: 'preserve',
      sectionPolicy: 'preserve',
      protectedSections: ['dsh-safety', 'permissions', 'plan', 'agents', 'skills'],
    },
    ...overrides,
  }
}

describe('CompatibilityGate', () => {
  it('accepts a target inside the shared baseline ceiling', () => {
    const baseline = new SharedBaselineRegistry().resolve(baselineDefinition())
    const decision = new CompatibilityGate().evaluate({ baseline, target: target() })

    expect(decision).toEqual({
      status: 'compatible',
      effectiveTools: ['shell_command', 'apply_patch', 'fs_search'],
      differences: [],
      reasons: [],
    })
    expect(Object.isFrozen(decision)).toBe(true)
  })

  it('rejects tools outside the ceiling or on the Work Agent deny list', () => {
    const baseline = new SharedBaselineRegistry().resolve(baselineDefinition())
    const decision = new CompatibilityGate().evaluate({
      baseline,
      target: target({
        toolCatalog: ['shell_command', 'unknown_tool', 'mistymoon_memory_write'],
      }),
    })

    expect(decision).toMatchObject({ status: 'incompatible', effectiveTools: ['shell_command'] })
    expect(decision.reasons).toEqual(expect.arrayContaining([
      { code: 'tool-outside-ceiling', subject: 'unknown_tool' },
      { code: 'tool-denied', subject: 'mistymoon_memory_write' },
    ]))
  })

  it('rejects sandbox, approval and delegation escalation', () => {
    const baseline = new SharedBaselineRegistry().resolve(baselineDefinition({
      sandboxCeiling: 'read-only',
    }))
    const decision = new CompatibilityGate().evaluate({
      baseline,
      target: target({
        baselineFingerprint: baseline.fingerprint,
        sandbox: 'workspace-write',
        approval: 'on-request',
        delegationDepth: 2,
      }),
    })

    expect(decision.reasons.map(({ code }) => code)).toEqual(expect.arrayContaining([
      'sandbox-escalation',
      'approval-escalation',
      'delegation-depth-exceeded',
    ]))
    expect(decision.status).toBe('incompatible')
  })

  it.each([
    ['persona-override', { persona: 'complete', runtimeContext: 'preserve', sectionPolicy: 'preserve' }],
    ['runtime-context-suppressed', { persona: 'neutral-work', runtimeContext: 'suppress', sectionPolicy: 'preserve' }],
    ['protected-sections-cleared', { persona: 'neutral-work', runtimeContext: 'preserve', sectionPolicy: 'clear-other-sections' }],
  ] as const)('rejects unsafe prompt behavior: %s', (code, promptMode) => {
    const baseline = new SharedBaselineRegistry().resolve(baselineDefinition())
    const decision = new CompatibilityGate().evaluate({
      baseline,
      target: target({
        prompt: { ...promptMode, protectedSections: baseline.protectedSections },
      }),
    })

    expect(decision).toMatchObject({
      status: 'incompatible',
      reasons: expect.arrayContaining([expect.objectContaining({ code })]),
    })
  })

  it('rejects a missing protected section and a changed baseline fingerprint', () => {
    const baseline = new SharedBaselineRegistry().resolve(baselineDefinition())
    const decision = new CompatibilityGate().evaluate({
      baseline,
      target: target({
        baselineFingerprint: 'e'.repeat(64),
        prompt: {
          ...target().prompt,
          protectedSections: ['dsh-safety', 'permissions'],
        },
      }),
    })

    expect(decision.reasons).toEqual(expect.arrayContaining([
      { code: 'baseline-mismatch', subject: 'baseline-2026-08-17.1' },
      { code: 'protected-section-missing', subject: 'plan' },
      { code: 'protected-section-missing', subject: 'agents' },
      { code: 'protected-section-missing', subject: 'skills' },
    ]))
  })

  it.each([
    ['provider-not-allowed', { id: 'flash-max', provider: 'other-provider', model: 'deepseek-v4-flash', reasoning: 'max' }],
    ['model-not-allowed', { id: 'flash-max', provider: 'deepseek-official', model: 'other-model', reasoning: 'max' }],
    ['route-mismatch', { id: 'flash-max', provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoning: 'max' }],
    ['reasoning-not-max', { id: 'flash-max', provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoning: 'high' }],
  ] as const)('rejects invalid DeepSeek request policy: %s', (code, route) => {
    const baseline = new SharedBaselineRegistry().resolve(baselineDefinition())
    const decision = new CompatibilityGate().evaluate({
      baseline,
      target: target({ route }),
    })

    expect(decision).toMatchObject({
      status: 'incompatible',
      reasons: expect.arrayContaining([expect.objectContaining({ code })]),
    })
  })

  it('binds a configured route id to one exact provider/model/max tuple', () => {
    const route = {
      id: 'configured-bbd3688a517c5c5d4b89d6ecde532d9c8a835bc807e39d85b1fa7451fd2f6d38' as const,
      provider: 'opencode-go',
      model: 'deepseek-v4-flash',
      reasoning: 'max' as const,
    }
    const baseline = new SharedBaselineRegistry().resolve(baselineDefinition({
      providerAllowlist: ['deepseek-official', 'opencode-go'],
    }))

    expect(configuredWorkRouteId(route)).toBe(route.id)
    expect(new CompatibilityGate().evaluate({
      baseline,
      target: target({ baselineFingerprint: baseline.fingerprint, route }),
    }).status).toBe('compatible')
    expect(new CompatibilityGate().evaluate({
      baseline,
      target: target({
        baselineFingerprint: baseline.fingerprint,
        route: { ...route, provider: 'deepseek-official' },
      }),
    })).toMatchObject({
      status: 'incompatible',
      reasons: expect.arrayContaining([{ code: 'route-mismatch', subject: route.id }]),
    })
  })

  it('requires Owner confirmation for capability and cost increases', () => {
    const baseline = new SharedBaselineRegistry().resolve(baselineDefinition())
    const current = target()
    const next = target({
      preset: preset('anchored-standard-jspace'),
      route: {
        id: 'pro-max',
        provider: 'deepseek-official',
        model: 'deepseek-v4-pro',
        reasoning: 'max',
      },
      toolCatalog: [...current.toolCatalog, 'jspace_ledger'],
    })
    const decision = new CompatibilityGate().evaluate({ baseline, current, target: next })

    expect(decision.status).toBe('confirmation-required')
    expect(decision.differences).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'profile-changed', impact: 'capability-increase' }),
      expect.objectContaining({ kind: 'route-changed', impact: 'cost-increase' }),
      expect.objectContaining({ kind: 'tool-added', subject: 'jspace_ledger', impact: 'capability-increase' }),
    ]))
  })

  it('does not require confirmation for a pure capability and cost reduction', () => {
    const baseline = new SharedBaselineRegistry().resolve(baselineDefinition())
    const current = target({
      preset: preset('anchored-standard-jspace'),
      route: {
        id: 'pro-max',
        provider: 'deepseek-official',
        model: 'deepseek-v4-pro',
        reasoning: 'max',
      },
      toolCatalog: ['shell_command', 'apply_patch', 'fs_search', 'jspace_ledger'],
    })
    const decision = new CompatibilityGate().evaluate({
      baseline,
      current,
      target: target(),
    })

    expect(decision.status).toBe('compatible')
    expect(decision.differences).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'profile-changed', impact: 'capability-decrease' }),
      expect.objectContaining({ kind: 'route-changed', impact: 'cost-decrease' }),
      expect.objectContaining({ kind: 'tool-removed', subject: 'jspace_ledger', impact: 'capability-decrease' }),
    ]))
  })
})

describe('prepareWorkActivationPublication', () => {
  it('produces a stable path-free Adapter snapshot only for compatible policy', () => {
    const baseline = new SharedBaselineRegistry().resolve(baselineDefinition())
    const publication = prepareWorkActivationPublication({ baseline, target: target() })
    const repeated = prepareWorkActivationPublication({ baseline, target: target() })

    expect(publication).toMatchObject({
      version: 1,
      governanceFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
      baselineFingerprint: baseline.fingerprint,
      presetId: 'anchored-standard',
      nativePresetId: 'mistymoon-work-anchored-standard-v1',
      presetFingerprint: 'd'.repeat(64),
      route: {
        id: 'flash-max',
        provider: 'deepseek-official',
        model: 'deepseek-v4-flash',
        reasoning: 'max',
      },
      effectiveTools: ['shell_command', 'apply_patch', 'fs_search'],
    })
    expect(repeated.governanceFingerprint).toBe(publication.governanceFingerprint)
    expect(Object.isFrozen(publication)).toBe(true)
    expect(JSON.stringify(publication)).not.toMatch(/[A-Z]:\\|\//u)
  })

  it('fails before Adapter construction when the policy is incompatible', () => {
    const baseline = new SharedBaselineRegistry().resolve(baselineDefinition())
    const incompatible = () => prepareWorkActivationPublication({
      baseline,
      target: target({ approval: 'on-request' }),
    })

    expect(incompatible).toThrow(WorkActivationPublicationError)
    try {
      incompatible()
    } catch (error) {
      expect(error).toMatchObject({
        status: 'incompatible',
        reasons: expect.arrayContaining([
          { code: 'approval-escalation', subject: 'on-request' },
        ]),
      })
    }
  })
})
