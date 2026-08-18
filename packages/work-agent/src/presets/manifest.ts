import type {
  WorkPresetIdV1,
  WorkPresetManifestV1,
  WorkPresetUpstreamV1,
} from '../contracts.js'
import { fingerprintCanonicalValue } from '../baseline/canonicalize.js'

const DSH_COMPATIBILITY = {
  version: '0.1.0-rc.7',
  commit: '99f6f02fecdb7dff40c3fbc9470f5907c29f74ca',
} as const

const ANCHORED_STANDARD = {
  project: 'anchored-standard',
  commit: '25f21aefaf8ddc414da54d2e581e43740d977c6e',
  checksum: 'cefdb574edf0f160e97e46bbc4c891443e4978a5334455e19918543ea323c07a',
  checksumAlgorithm: 'sha256-git-ls-tree-v1',
  delivery: 'bundled',
  licenseStatus: 'ready',
  licenseSpdx: 'MIT',
  protectedSectionsCompatibility: 'requires-policy-shield',
} as const satisfies WorkPresetUpstreamV1

const J_SPACE = {
  project: 'j-space',
  commit: '27e69e29160b733143f0e52b5e8877e0485a767d',
  checksum: '7deea59e48801aaab39d5c7b7e9d6a2bdc875a14386a37f4cbee508f232e4c4f',
  checksumAlgorithm: 'sha256-git-ls-tree-v1',
  delivery: 'bundled',
  licenseStatus: 'ready',
  licenseSpdx: 'Apache-2.0',
  protectedSectionsCompatibility: 'preserves',
} as const satisfies WorkPresetUpstreamV1

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value
  for (const child of Object.values(value)) deepFreeze(child)
  return Object.freeze(value)
}

function fixedManifest(
  id: WorkPresetIdV1,
  upstreams: readonly WorkPresetUpstreamV1[],
  activationStatus: WorkPresetManifestV1['activationStatus'],
  requiredCapabilities: readonly string[],
): WorkPresetManifestV1 {
  const definition = {
    version: 1,
    id,
    nativePresetId: `mistymoon-work-${id}-v1`,
    upstreams,
    dshCompatibility: DSH_COMPATIBILITY,
    compatibilityPatchVersion: 'mistymoon-work-policy-shield-v2',
    licenseStatus: 'ready',
    activationStatus,
    requiredCapabilities,
  } as const

  return deepFreeze({
    version: 1,
    preset: {
      version: 1,
      id,
      nativePresetId: definition.nativePresetId,
      manifestFingerprint: fingerprintCanonicalValue(definition),
      upstreams,
    },
    dshCompatibility: DSH_COMPATIBILITY,
    compatibilityPatchVersion: definition.compatibilityPatchVersion,
    licenseStatus: definition.licenseStatus,
    activationStatus,
    requiredCapabilities,
  })
}

const FIXED_WORK_PRESET_MANIFESTS = deepFreeze([
  fixedManifest(
    'anchored-standard',
    [ANCHORED_STANDARD],
    'default',
    [],
  ),
  fixedManifest(
    'anchored-standard-jspace',
    [ANCHORED_STANDARD, J_SPACE],
    'experimental-disabled',
    ['j-space-experiment-enabled'],
  ),
] satisfies readonly WorkPresetManifestV1[])

/** Returns the audited, path-free Phase 0 manifests at their fixed upstream commits. */
export function getFixedWorkPresetManifests(): readonly WorkPresetManifestV1[] {
  return FIXED_WORK_PRESET_MANIFESTS
}
