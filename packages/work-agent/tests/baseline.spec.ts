import { describe, expect, it } from 'vitest'
import {
  BaselineGenerationConflictError,
  InvalidSharedBaselineError,
  SharedBaselineRegistry,
  type SharedBaselineDefinitionV1,
} from '../src/index.js'

function baseline(
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
    protectedSections: ['dsh-safety', 'agents', 'skills'],
    workspacePolicy: 'parent-cwd-only',
    sandboxCeiling: 'workspace-write',
    approvalPolicy: 'never',
    maxDelegationDepth: 1,
    providerAllowlist: ['deepseek-official'],
    modelAllowlist: ['deepseek-v4-flash', 'deepseek-v4-pro'],
    rolePolicies: {
      rpHost: {
        toolAllow: ['mistymoon_delegate_work'],
        toolDeny: ['shell_command'],
      },
      workAgent: {
        toolAllow: ['shell_command', 'apply_patch'],
        toolDeny: ['mistymoon_prepare_final_reply'],
      },
    },
    contractVersions: { delegation: 1, report: 1, handoff: 1 },
    ...overrides,
  }
}

describe('SharedBaselineRegistry', () => {
  it('returns a deeply immutable snapshot with a SHA-256 fingerprint', () => {
    const snapshot = new SharedBaselineRegistry().resolve(baseline())

    expect(snapshot.fingerprint).toMatch(/^[a-f0-9]{64}$/)
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(Object.isFrozen(snapshot.dshCompatibility)).toBe(true)
    expect(Object.isFrozen(snapshot.rolePolicies.workAgent.toolAllow)).toBe(true)
    expect(() => (snapshot.rolePolicies.workAgent.toolAllow as string[]).push('unsafe')).toThrow()
  })

  it('canonicalizes object keys while preserving governed array order', () => {
    const normal = baseline()
    const reordered = {
      contractVersions: { handoff: 1, report: 1, delegation: 1 },
      rolePolicies: {
        workAgent: {
          toolDeny: ['mistymoon_prepare_final_reply'],
          toolAllow: ['shell_command', 'apply_patch'],
        },
        rpHost: {
          toolDeny: ['shell_command'],
          toolAllow: ['mistymoon_delegate_work'],
        },
      },
      modelAllowlist: ['deepseek-v4-flash', 'deepseek-v4-pro'],
      providerAllowlist: ['deepseek-official'],
      maxDelegationDepth: 1,
      approvalPolicy: 'never',
      sandboxCeiling: 'workspace-write',
      workspacePolicy: 'parent-cwd-only',
      protectedSections: ['dsh-safety', 'agents', 'skills'],
      ownerEligibilityPolicy: 'mistymoon-owner-eligibility-v1',
      dshCompatibility: {
        commit: '99f6f02fecdb7dff40c3fbc9470f5907c29f74ca',
        version: '0.1.0-rc.7',
      },
      generation: 'baseline-2026-08-17.1',
      version: 1,
    } satisfies SharedBaselineDefinitionV1

    const first = new SharedBaselineRegistry().resolve(normal)
    const second = new SharedBaselineRegistry().resolve(reordered)
    const arrayOrderChanged = new SharedBaselineRegistry().resolve(baseline({
      protectedSections: ['agents', 'dsh-safety', 'skills'],
    }))

    expect(first.fingerprint).toBe(second.fingerprint)
    expect(arrayOrderChanged.fingerprint).not.toBe(first.fingerprint)
  })

  it('changes the fingerprint when a governed field changes', () => {
    const original = new SharedBaselineRegistry().resolve(baseline())
    const changes: SharedBaselineDefinitionV1[] = [
      baseline({ generation: 'baseline-2026-08-17.2' }),
      baseline({ dshCompatibility: { version: '0.1.0-rc.8', commit: '99f6f02fecdb7dff40c3fbc9470f5907c29f74ca' } }),
      baseline({ ownerEligibilityPolicy: 'mistymoon-owner-eligibility-v2' }),
      baseline({ protectedSections: ['dsh-safety', 'agents', 'skills', 'plan'] }),
      baseline({ sandboxCeiling: 'read-only' }),
      baseline({ providerAllowlist: ['deepseek-official', 'test-provider'] }),
      baseline({ modelAllowlist: ['deepseek-v4-flash'] }),
      baseline({ rolePolicies: { ...baseline().rolePolicies, workAgent: { toolAllow: ['apply_patch'], toolDeny: ['mistymoon_prepare_final_reply'] } } }),
    ]

    for (const changed of changes) {
      expect(new SharedBaselineRegistry().resolve(changed).fingerprint)
        .not.toBe(original.fingerprint)
    }
  })

  it('reuses an identical generation and rejects conflicting contents', () => {
    const registry = new SharedBaselineRegistry()
    const first = registry.resolve(baseline())

    expect(registry.resolve(baseline())).toBe(first)
    expect(() => registry.resolve(baseline({ sandboxCeiling: 'read-only' })))
      .toThrow(BaselineGenerationConflictError)
  })

  it.each(['credentials', 'profilePath', 'persona', 'memory', 'transcript'])(
    'rejects the unknown field %s instead of retaining private payloads',
    (field) => {
      const definition: unknown = { ...baseline(), [field]: 'private-value' }

      expect(() => new SharedBaselineRegistry().resolve(
        definition as SharedBaselineDefinitionV1,
      )).toThrow(InvalidSharedBaselineError)
    },
  )
})
