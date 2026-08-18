import type {
  DshCompatibilityV1,
  ResolvedWorkPresetV1,
  WorkPresetDiscoveryV1,
  WorkPresetIdV1,
  WorkPresetManifestV1,
  WorkPresetRefV1,
  WorkPresetResolverOptions,
  WorkPresetUpstreamV1,
} from '../contracts.js'

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+-]*$/
const SHA256 = /^[a-f0-9]{64}$/
const COMMIT = /^[a-f0-9]{40}$/
const PRESET_IDS = new Set<WorkPresetIdV1>([
  'anchored-standard',
  'anchored-standard-jspace',
])
const UPSTREAM_COMMITS = {
  'anchored-standard': '25f21aefaf8ddc414da54d2e581e43740d977c6e',
  'j-space': '27e69e29160b733143f0e52b5e8877e0485a767d',
} as const

/** Resolver failure class exposed without provision internals. */
export type WorkPresetResolutionStatus = 'not-ready' | 'incompatible'
/** Stable reason for a fixed preset preflight failure. */
export type WorkPresetResolutionReason =
  | 'preset-not-discovered'
  | 'manifest-mismatch'
  | 'license-not-ready'
  | 'mutable-provision'
  | 'missing-capability'
  | 'dsh-incompatible'

/** Rejects arbitrary profile ids and path-like caller input. */
export class UnknownWorkPresetError extends Error {
  constructor(readonly id: string) {
    super(`Unknown Work preset "${id}".`)
    this.name = 'UnknownWorkPresetError'
  }
}

/** Indicates malformed trusted manifest or sanitized discovery metadata. */
export class InvalidWorkPresetManifestError extends TypeError {
  constructor(message: string) {
    super(`Invalid Work preset manifest: ${message}`)
    this.name = 'InvalidWorkPresetManifestError'
  }
}

/** Structured preflight failure; no fallback preset may be substituted. */
export class WorkPresetResolutionError extends Error {
  constructor(
    readonly status: WorkPresetResolutionStatus,
    readonly reason: WorkPresetResolutionReason,
    message: string,
  ) {
    super(message)
    this.name = 'WorkPresetResolutionError'
  }
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new InvalidWorkPresetManifestError(`${path} must be an object.`)
  }
  return value as Record<string, unknown>
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], path: string): void {
  const allowed = new Set(keys)
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new InvalidWorkPresetManifestError(`${path}.${key} is not an allowed field.`)
    }
  }
  for (const key of keys) {
    if (!(key in value)) throw new InvalidWorkPresetManifestError(`${path}.${key} is required.`)
  }
}

function identifier(value: unknown, path: string): string {
  if (typeof value !== 'string' || !IDENTIFIER.test(value)) {
    throw new InvalidWorkPresetManifestError(`${path} must be a non-path identifier.`)
  }
  return value
}

function digest(value: unknown, path: string): string {
  if (typeof value !== 'string' || !SHA256.test(value)) {
    throw new InvalidWorkPresetManifestError(`${path} must be a lowercase SHA-256 digest.`)
  }
  return value
}

function commit(value: unknown, path: string): string {
  if (typeof value !== 'string' || !COMMIT.test(value)) {
    throw new InvalidWorkPresetManifestError(`${path} must be a full lowercase Git commit.`)
  }
  return value
}

function stringArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) throw new InvalidWorkPresetManifestError(`${path} must be an array.`)
  return value.map((entry, index) => identifier(entry, `${path}[${index}]`))
}

function dshCompatibility(value: unknown, path: string): DshCompatibilityV1 {
  const input = record(value, path)
  exactKeys(input, ['version', 'commit'], path)
  return {
    version: identifier(input.version, `${path}.version`),
    commit: commit(input.commit, `${path}.commit`),
  }
}

function upstream(value: unknown, path: string): WorkPresetUpstreamV1 {
  const input = record(value, path)
  exactKeys(input, [
    'project',
    'commit',
    'checksum',
    'checksumAlgorithm',
    'delivery',
    'licenseStatus',
    'licenseSpdx',
    'protectedSectionsCompatibility',
  ], path)
  if (input.project !== 'anchored-standard' && input.project !== 'j-space') {
    throw new InvalidWorkPresetManifestError(`${path}.project is unsupported.`)
  }
  if (input.delivery !== 'bundled' && input.delivery !== 'external') {
    throw new InvalidWorkPresetManifestError(`${path}.delivery is unsupported.`)
  }
  if (input.checksumAlgorithm !== 'sha256-git-ls-tree-v1') {
    throw new InvalidWorkPresetManifestError(`${path}.checksumAlgorithm is unsupported.`)
  }
  if (input.licenseStatus !== 'ready'
    && input.licenseStatus !== 'external-only'
    && input.licenseStatus !== 'not-ready') {
    throw new InvalidWorkPresetManifestError(`${path}.licenseStatus is unsupported.`)
  }
  if (input.licenseSpdx !== 'MIT'
    && input.licenseSpdx !== 'Apache-2.0'
    && input.licenseSpdx !== 'NOASSERTION') {
    throw new InvalidWorkPresetManifestError(`${path}.licenseSpdx is unsupported.`)
  }
  if (input.protectedSectionsCompatibility !== 'preserves'
    && input.protectedSectionsCompatibility !== 'requires-policy-shield') {
    throw new InvalidWorkPresetManifestError(`${path}.protectedSectionsCompatibility is unsupported.`)
  }
  return {
    project: input.project,
    commit: commit(input.commit, `${path}.commit`),
    checksum: digest(input.checksum, `${path}.checksum`),
    checksumAlgorithm: input.checksumAlgorithm,
    delivery: input.delivery,
    licenseStatus: input.licenseStatus,
    licenseSpdx: input.licenseSpdx,
    protectedSectionsCompatibility: input.protectedSectionsCompatibility,
  }
}

function upstreams(value: unknown, path: string): WorkPresetUpstreamV1[] {
  if (!Array.isArray(value)) throw new InvalidWorkPresetManifestError(`${path} must be an array.`)
  const result = value.map((entry, index) => upstream(entry, `${path}[${index}]`))
  if (new Set(result.map(({ project }) => project)).size !== result.length) {
    throw new InvalidWorkPresetManifestError(`${path} contains a duplicate project.`)
  }
  return result
}

function presetRef(value: unknown, path: string): WorkPresetRefV1 {
  const input = record(value, path)
  exactKeys(input, ['version', 'id', 'nativePresetId', 'manifestFingerprint', 'upstreams'], path)
  if (input.version !== 1) throw new InvalidWorkPresetManifestError(`${path}.version must be 1.`)
  if (typeof input.id !== 'string' || !PRESET_IDS.has(input.id as WorkPresetIdV1)) {
    throw new InvalidWorkPresetManifestError(`${path}.id is unsupported.`)
  }
  return {
    version: 1,
    id: input.id as WorkPresetIdV1,
    nativePresetId: identifier(input.nativePresetId, `${path}.nativePresetId`),
    manifestFingerprint: digest(input.manifestFingerprint, `${path}.manifestFingerprint`),
    upstreams: upstreams(input.upstreams, `${path}.upstreams`),
  }
}

function validateComposition(preset: WorkPresetRefV1): void {
  const expectedProjects = preset.id === 'anchored-standard'
    ? ['anchored-standard'] as const
    : ['anchored-standard', 'j-space'] as const
  const actualProjects = new Set(preset.upstreams.map(({ project }) => project))
  if (actualProjects.size !== expectedProjects.length
    || expectedProjects.some((project) => !actualProjects.has(project))) {
    throw new InvalidWorkPresetManifestError(
      `${preset.id} must contain exactly ${expectedProjects.join(', ')}.`,
    )
  }
  for (const item of preset.upstreams) {
    if (item.commit !== UPSTREAM_COMMITS[item.project]) {
      throw new InvalidWorkPresetManifestError(
        `${item.project} is not pinned to the approved commit.`,
      )
    }
  }
}

function manifest(value: unknown, path: string): WorkPresetManifestV1 {
  const input = record(value, path)
  exactKeys(input, [
    'version',
    'preset',
    'dshCompatibility',
    'compatibilityPatchVersion',
    'licenseStatus',
    'activationStatus',
    'requiredCapabilities',
  ], path)
  if (input.version !== 1) throw new InvalidWorkPresetManifestError(`${path}.version must be 1.`)
  if (input.licenseStatus !== 'ready'
    && input.licenseStatus !== 'external-only'
    && input.licenseStatus !== 'not-ready') {
    throw new InvalidWorkPresetManifestError(`${path}.licenseStatus is unsupported.`)
  }
  if (input.activationStatus !== 'default' && input.activationStatus !== 'experimental-disabled') {
    throw new InvalidWorkPresetManifestError(`${path}.activationStatus is unsupported.`)
  }
  const result: WorkPresetManifestV1 = {
    version: 1,
    preset: presetRef(input.preset, `${path}.preset`),
    dshCompatibility: dshCompatibility(input.dshCompatibility, `${path}.dshCompatibility`),
    compatibilityPatchVersion: identifier(input.compatibilityPatchVersion, `${path}.compatibilityPatchVersion`),
    licenseStatus: input.licenseStatus,
    activationStatus: input.activationStatus,
    requiredCapabilities: stringArray(input.requiredCapabilities, `${path}.requiredCapabilities`),
  }
  validateComposition(result.preset)
  const expectedCapabilities = result.preset.id === 'anchored-standard-jspace'
    ? ['j-space-experiment-enabled']
    : []
  if (result.requiredCapabilities.length !== expectedCapabilities.length
    || expectedCapabilities.some(capability => !result.requiredCapabilities.includes(capability))) {
    throw new InvalidWorkPresetManifestError(
      `${path}.requiredCapabilities must match the fixed profile capabilities.`,
    )
  }
  return result
}

function discovery(value: unknown, path: string): WorkPresetDiscoveryV1 {
  const input = record(value, path)
  exactKeys(input, [
    'nativePresetId',
    'manifestFingerprint',
    'upstreams',
    'immutableProvision',
    'capabilities',
  ], path)
  if (typeof input.immutableProvision !== 'boolean') {
    throw new InvalidWorkPresetManifestError(`${path}.immutableProvision must be boolean.`)
  }
  return {
    nativePresetId: identifier(input.nativePresetId, `${path}.nativePresetId`),
    manifestFingerprint: digest(input.manifestFingerprint, `${path}.manifestFingerprint`),
    upstreams: upstreams(input.upstreams, `${path}.upstreams`),
    immutableProvision: input.immutableProvision,
    capabilities: stringArray(input.capabilities, `${path}.capabilities`),
  }
}

function sameDsh(left: DshCompatibilityV1, right: DshCompatibilityV1): boolean {
  return left.version === right.version && left.commit === right.commit
}

function sameUpstreams(
  left: readonly WorkPresetUpstreamV1[],
  right: readonly WorkPresetUpstreamV1[],
): boolean {
  if (left.length !== right.length) return false
  const byProject = new Map(right.map((entry) => [entry.project, entry]))
  return left.every((entry) => {
    const other = byProject.get(entry.project)
    return other?.commit === entry.commit
      && other.checksum === entry.checksum
      && other.checksumAlgorithm === entry.checksumAlgorithm
      && other.delivery === entry.delivery
      && other.licenseStatus === entry.licenseStatus
      && other.licenseSpdx === entry.licenseSpdx
      && other.protectedSectionsCompatibility === entry.protectedSectionsCompatibility
  })
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value
  for (const child of Object.values(value)) deepFreeze(child)
  return Object.freeze(value)
}

/** Resolves only fixed, discovered and fully governed Work preset manifests. */
export class WorkPresetResolver {
  readonly #dshCompatibility: DshCompatibilityV1
  readonly #manifests = new Map<WorkPresetIdV1, WorkPresetManifestV1>()
  readonly #discovery = new Map<string, WorkPresetDiscoveryV1>()

  constructor(options: WorkPresetResolverOptions) {
    this.#dshCompatibility = dshCompatibility(options.dshCompatibility, 'options.dshCompatibility')
    for (const [index, value] of options.manifests.entries()) {
      const normalized = manifest(value, `options.manifests[${index}]`)
      if (this.#manifests.has(normalized.preset.id)) {
        throw new InvalidWorkPresetManifestError(`duplicate profile ${normalized.preset.id}.`)
      }
      this.#manifests.set(normalized.preset.id, deepFreeze(normalized))
    }
    for (const [index, value] of options.discovery.entries()) {
      const normalized = discovery(value, `options.discovery[${index}]`)
      if (this.#discovery.has(normalized.nativePresetId)) {
        throw new InvalidWorkPresetManifestError(`duplicate discovery ${normalized.nativePresetId}.`)
      }
      this.#discovery.set(normalized.nativePresetId, deepFreeze(normalized))
    }
  }

  /** Resolves a fixed profile or fails loudly without fallback. */
  resolve(id: WorkPresetIdV1): ResolvedWorkPresetV1 {
    if (typeof id !== 'string' || !PRESET_IDS.has(id as WorkPresetIdV1)) {
      throw new UnknownWorkPresetError(String(id))
    }
    const source = this.#manifests.get(id)
    if (!source) throw new UnknownWorkPresetError(id)
    if (source.licenseStatus === 'not-ready') {
      throw new WorkPresetResolutionError(
        'not-ready',
        'license-not-ready',
        `Work preset "${id}" has unresolved license metadata.`,
      )
    }
    if (!sameDsh(source.dshCompatibility, this.#dshCompatibility)) {
      throw new WorkPresetResolutionError(
        'incompatible',
        'dsh-incompatible',
        `Work preset "${id}" was verified against another DSH build.`,
      )
    }
    const found = this.#discovery.get(source.preset.nativePresetId)
    if (!found) {
      throw new WorkPresetResolutionError(
        'not-ready',
        'preset-not-discovered',
        `Work preset "${id}" is not discovered.`,
      )
    }
    if (!found.immutableProvision) {
      throw new WorkPresetResolutionError(
        'not-ready',
        'mutable-provision',
        `Work preset "${id}" is not provisioned immutably.`,
      )
    }
    const missing = source.requiredCapabilities.find((capability) => !found.capabilities.includes(capability))
    if (missing) {
      throw new WorkPresetResolutionError(
        'not-ready',
        'missing-capability',
        `Work preset "${id}" is missing capability "${missing}".`,
      )
    }
    if (found.manifestFingerprint !== source.preset.manifestFingerprint
      || !sameUpstreams(found.upstreams, source.preset.upstreams)) {
      throw new WorkPresetResolutionError(
        'not-ready',
        'manifest-mismatch',
        `Work preset "${id}" does not match its fixed manifest.`,
      )
    }

    return deepFreeze({
      ...source.preset,
      compatibilityPatchVersion: source.compatibilityPatchVersion,
    })
  }
}
