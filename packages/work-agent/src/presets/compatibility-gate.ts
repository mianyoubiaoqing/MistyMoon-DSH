import type {
  CompatibilityDecisionV1,
  CompatibilityGateInputV1,
  CompatibilityReasonV1,
  PolicyDifferenceV1,
  SharedBaselineSnapshotV1,
  WorkActivationPolicyV1,
  WorkRouteIdV1,
} from '../contracts.js'
import { configuredWorkRouteId } from '../controller/configured-work-route.js'

const ROUTES = {
  'flash-max': {
    provider: 'deepseek-official',
    model: 'deepseek-v4-flash',
    rank: 0,
  },
  'pro-max': {
    provider: 'deepseek-official',
    model: 'deepseek-v4-pro',
    rank: 2,
  },
} as const

function reason(
  reasons: CompatibilityReasonV1[],
  code: CompatibilityReasonV1['code'],
  subject: string,
): void {
  reasons.push({ code, subject })
}

function effectiveTools(
  baseline: SharedBaselineSnapshotV1,
  target: WorkActivationPolicyV1,
  reasons: CompatibilityReasonV1[],
): string[] {
  const allowed = new Set(baseline.rolePolicies.workAgent.toolAllow)
  const denied = new Set(baseline.rolePolicies.workAgent.toolDeny)
  const effective: string[] = []
  const seen = new Set<string>()
  for (const tool of target.toolCatalog) {
    if (seen.has(tool)) continue
    seen.add(tool)
    if (denied.has(tool)) {
      reason(reasons, 'tool-denied', tool)
      continue
    }
    if (!allowed.has(tool)) {
      reason(reasons, 'tool-outside-ceiling', tool)
      continue
    }
    effective.push(tool)
  }
  return effective
}

function inspectBaselinePolicy(
  baseline: SharedBaselineSnapshotV1,
  target: WorkActivationPolicyV1,
  reasons: CompatibilityReasonV1[],
): void {
  if (target.baselineFingerprint !== baseline.fingerprint) {
    reason(reasons, 'baseline-mismatch', baseline.generation)
  }
  if (baseline.sandboxCeiling === 'read-only' && target.sandbox !== 'read-only') {
    reason(reasons, 'sandbox-escalation', target.sandbox)
  }
  if (target.approval !== 'never') {
    reason(reasons, 'approval-escalation', target.approval)
  }
  if (target.delegationDepth > baseline.maxDelegationDepth) {
    reason(reasons, 'delegation-depth-exceeded', String(target.delegationDepth))
  }
}

function inspectPromptPolicy(
  baseline: SharedBaselineSnapshotV1,
  target: WorkActivationPolicyV1,
  reasons: CompatibilityReasonV1[],
): void {
  if (target.prompt.persona !== 'neutral-work') {
    reason(reasons, 'persona-override', target.prompt.persona)
  }
  if (target.prompt.runtimeContext !== 'preserve') {
    reason(reasons, 'runtime-context-suppressed', target.prompt.runtimeContext)
  }
  if (target.prompt.sectionPolicy !== 'preserve') {
    reason(reasons, 'protected-sections-cleared', target.prompt.sectionPolicy)
  }
  const present = new Set(target.prompt.protectedSections)
  for (const section of baseline.protectedSections) {
    if (!present.has(section)) reason(reasons, 'protected-section-missing', section)
  }
}

function inspectRoutePolicy(
  baseline: SharedBaselineSnapshotV1,
  target: WorkActivationPolicyV1,
  reasons: CompatibilityReasonV1[],
): void {
  if (!baseline.providerAllowlist.includes(target.route.provider)) {
    reason(reasons, 'provider-not-allowed', target.route.provider)
  }
  if (!baseline.modelAllowlist.includes(target.route.model)) {
    reason(reasons, 'model-not-allowed', target.route.model)
  }
  const route = ROUTES[target.route.id as keyof typeof ROUTES]
  const configured = target.route.id.startsWith('configured-')
    && target.route.id === configuredWorkRouteId(target.route)
  if ((!route && !configured)
    || (route !== undefined
      && (route.provider !== target.route.provider || route.model !== target.route.model))) {
    reason(reasons, 'route-mismatch', target.route.id)
  }
  if (target.route.reasoning !== 'max') {
    reason(reasons, 'reasoning-not-max', target.route.reasoning)
  }
}

function profileRank(policy: WorkActivationPolicyV1): number {
  return policy.preset.id === 'anchored-standard-jspace' ? 1 : 0
}

function routeRank(route: WorkRouteIdV1): number {
  return ROUTES[route as keyof typeof ROUTES]?.rank ?? 1
}

function differences(
  current: WorkActivationPolicyV1 | undefined,
  target: WorkActivationPolicyV1,
): PolicyDifferenceV1[] {
  if (!current) return []
  const result: PolicyDifferenceV1[] = []
  if (current.preset.id !== target.preset.id) {
    result.push({
      kind: 'profile-changed',
      subject: target.preset.id,
      impact: profileRank(target) > profileRank(current)
        ? 'capability-increase'
        : 'capability-decrease',
    })
  }
  if (current.route.id !== target.route.id) {
    result.push({
      kind: 'route-changed',
      subject: target.route.id,
      impact: routeRank(target.route.id) > routeRank(current.route.id)
        ? 'cost-increase'
        : 'cost-decrease',
    })
  }

  const currentTools = new Set(current.toolCatalog)
  const targetTools = new Set(target.toolCatalog)
  for (const tool of targetTools) {
    if (!currentTools.has(tool)) {
      result.push({ kind: 'tool-added', subject: tool, impact: 'capability-increase' })
    }
  }
  for (const tool of currentTools) {
    if (!targetTools.has(tool)) {
      result.push({ kind: 'tool-removed', subject: tool, impact: 'capability-decrease' })
    }
  }
  return result
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value
  for (const child of Object.values(value)) deepFreeze(child)
  return Object.freeze(value)
}

/** Compares one activation surface against the immutable shared baseline. */
export class CompatibilityGate {
  /** Produces a frozen policy decision without mounting or mutating a preset. */
  evaluate(input: CompatibilityGateInputV1): CompatibilityDecisionV1 {
    const reasons: CompatibilityReasonV1[] = []
    const tools = effectiveTools(input.baseline, input.target, reasons)
    inspectBaselinePolicy(input.baseline, input.target, reasons)
    inspectPromptPolicy(input.baseline, input.target, reasons)
    inspectRoutePolicy(input.baseline, input.target, reasons)
    const policyDifferences = differences(input.current, input.target)
    const needsConfirmation = policyDifferences.some(({ impact }) =>
      impact === 'capability-increase' || impact === 'cost-increase')

    return deepFreeze({
      status: reasons.length > 0
        ? 'incompatible'
        : needsConfirmation
          ? 'confirmation-required'
          : 'compatible',
      effectiveTools: tools,
      differences: policyDifferences,
      reasons,
    })
  }
}
