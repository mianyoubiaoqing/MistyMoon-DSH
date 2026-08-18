import type {
  SharedBaselineDefinitionV1,
  SharedBaselineSnapshotV1,
  WorkRolePolicyV1,
} from '../contracts.js'
import { fingerprintCanonicalValue } from './canonicalize.js'

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+-]*$/

/** Indicates a malformed or privacy-expanding baseline definition. */
export class InvalidSharedBaselineError extends TypeError {
  constructor(message: string) {
    super(`Invalid shared baseline: ${message}`)
    this.name = 'InvalidSharedBaselineError'
  }
}

/** Indicates attempted reuse of a generation id for different governance. */
export class BaselineGenerationConflictError extends Error {
  constructor(readonly generation: string) {
    super(`Shared baseline generation "${generation}" is already registered with different contents.`)
    this.name = 'BaselineGenerationConflictError'
  }
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new InvalidSharedBaselineError(`${path} must be an object.`)
  }
  return value as Record<string, unknown>
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  path: string,
): void {
  const expectedSet = new Set(expected)
  for (const key of Object.keys(value)) {
    if (!expectedSet.has(key)) {
      throw new InvalidSharedBaselineError(`${path}.${key} is not an allowed field.`)
    }
  }
  for (const key of expected) {
    if (!(key in value)) throw new InvalidSharedBaselineError(`${path}.${key} is required.`)
  }
}

function identifier(value: unknown, path: string): string {
  if (typeof value !== 'string' || !IDENTIFIER.test(value)) {
    throw new InvalidSharedBaselineError(`${path} must be a non-path identifier.`)
  }
  return value
}

function identifiers(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) throw new InvalidSharedBaselineError(`${path} must be an array.`)
  return value.map((entry, index) => identifier(entry, `${path}[${index}]`))
}

function literal<T extends string | number>(
  value: unknown,
  expected: T,
  path: string,
): T {
  if (value !== expected) {
    throw new InvalidSharedBaselineError(`${path} must be ${JSON.stringify(expected)}.`)
  }
  return expected
}

function sandboxCeiling(value: unknown): 'read-only' | 'workspace-write' {
  if (value !== 'read-only' && value !== 'workspace-write') {
    throw new InvalidSharedBaselineError('baseline.sandboxCeiling must be "read-only" or "workspace-write".')
  }
  return value
}

function rolePolicy(value: unknown, path: string): WorkRolePolicyV1 {
  const input = record(value, path)
  exactKeys(input, ['toolAllow', 'toolDeny'], path)
  return {
    toolAllow: identifiers(input.toolAllow, `${path}.toolAllow`),
    toolDeny: identifiers(input.toolDeny, `${path}.toolDeny`),
  }
}

function normalizeDefinition(value: unknown): SharedBaselineDefinitionV1 {
  const input = record(value, 'baseline')
  exactKeys(input, [
    'version',
    'generation',
    'dshCompatibility',
    'ownerEligibilityPolicy',
    'protectedSections',
    'workspacePolicy',
    'sandboxCeiling',
    'approvalPolicy',
    'maxDelegationDepth',
    'providerAllowlist',
    'modelAllowlist',
    'rolePolicies',
    'contractVersions',
  ], 'baseline')

  const dshCompatibility = record(input.dshCompatibility, 'baseline.dshCompatibility')
  exactKeys(dshCompatibility, ['version', 'commit'], 'baseline.dshCompatibility')

  const rolePolicies = record(input.rolePolicies, 'baseline.rolePolicies')
  exactKeys(rolePolicies, ['rpHost', 'workAgent'], 'baseline.rolePolicies')

  const contractVersions = record(input.contractVersions, 'baseline.contractVersions')
  exactKeys(contractVersions, ['delegation', 'report', 'handoff'], 'baseline.contractVersions')

  return {
    version: literal(input.version, 1, 'baseline.version'),
    generation: identifier(input.generation, 'baseline.generation'),
    dshCompatibility: {
      version: identifier(dshCompatibility.version, 'baseline.dshCompatibility.version'),
      commit: identifier(dshCompatibility.commit, 'baseline.dshCompatibility.commit'),
    },
    ownerEligibilityPolicy: identifier(input.ownerEligibilityPolicy, 'baseline.ownerEligibilityPolicy'),
    protectedSections: identifiers(input.protectedSections, 'baseline.protectedSections'),
    workspacePolicy: literal(input.workspacePolicy, 'parent-cwd-only', 'baseline.workspacePolicy'),
    sandboxCeiling: sandboxCeiling(input.sandboxCeiling),
    approvalPolicy: literal(input.approvalPolicy, 'never', 'baseline.approvalPolicy'),
    maxDelegationDepth: literal(input.maxDelegationDepth, 1, 'baseline.maxDelegationDepth'),
    providerAllowlist: identifiers(input.providerAllowlist, 'baseline.providerAllowlist'),
    modelAllowlist: identifiers(input.modelAllowlist, 'baseline.modelAllowlist'),
    rolePolicies: {
      rpHost: rolePolicy(rolePolicies.rpHost, 'baseline.rolePolicies.rpHost'),
      workAgent: rolePolicy(rolePolicies.workAgent, 'baseline.rolePolicies.workAgent'),
    },
    contractVersions: {
      delegation: literal(contractVersions.delegation, 1, 'baseline.contractVersions.delegation'),
      report: literal(contractVersions.report, 1, 'baseline.contractVersions.report'),
      handoff: literal(contractVersions.handoff, 1, 'baseline.contractVersions.handoff'),
    },
  }
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value
  for (const child of Object.values(value)) deepFreeze(child)
  return Object.freeze(value)
}

/** Resolves trusted baseline definitions into immutable, generation-scoped snapshots. */
export class SharedBaselineRegistry {
  readonly #snapshots = new Map<string, SharedBaselineSnapshotV1>()

  /** Returns the frozen snapshot for a definition's immutable generation. */
  resolve(definition: SharedBaselineDefinitionV1): SharedBaselineSnapshotV1 {
    const normalized = normalizeDefinition(definition)
    const fingerprint = fingerprintCanonicalValue(normalized)
    const existing = this.#snapshots.get(normalized.generation)
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        throw new BaselineGenerationConflictError(normalized.generation)
      }
      return existing
    }

    const snapshot = deepFreeze({ ...normalized, fingerprint })
    this.#snapshots.set(snapshot.generation, snapshot)
    return snapshot
  }
}
