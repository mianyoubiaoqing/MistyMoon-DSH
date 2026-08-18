import { describe, expect, it } from 'vitest'
import {
  getFixedWorkPresetManifests,
  InvalidWorkPresetManifestError,
  UnknownWorkPresetError,
  WorkPresetResolutionError,
  WorkPresetResolver,
  type WorkPresetDiscoveryV1,
  type WorkPresetManifestV1,
} from '../src/index.js'

const DSH = {
  version: '0.1.0-rc.7',
  commit: '99f6f02fecdb7dff40c3fbc9470f5907c29f74ca',
} as const

function manifest(
  id: 'anchored-standard' | 'anchored-standard-jspace' = 'anchored-standard',
  overrides: Partial<WorkPresetManifestV1> = {},
): WorkPresetManifestV1 {
  const fixed = getFixedWorkPresetManifests().find(({ preset }) => preset.id === id)
  if (!fixed) throw new Error(`Missing fixed manifest ${id}.`)
  return {
    ...fixed,
    preset: {
      ...fixed.preset,
      upstreams: fixed.preset.upstreams.map(upstream => ({ ...upstream })),
    },
    dshCompatibility: { ...fixed.dshCompatibility },
    requiredCapabilities: [...fixed.requiredCapabilities],
    ...overrides,
  }
}

function discovery(
  source = manifest(),
  overrides: Partial<WorkPresetDiscoveryV1> = {},
): WorkPresetDiscoveryV1 {
  return {
    nativePresetId: source.preset.nativePresetId,
    manifestFingerprint: source.preset.manifestFingerprint,
    upstreams: source.preset.upstreams,
    immutableProvision: true,
    capabilities: [...source.requiredCapabilities],
    ...overrides,
  }
}

function resolver(
  source = manifest(),
  found = discovery(source),
): WorkPresetResolver {
  return new WorkPresetResolver({
    dshCompatibility: DSH,
    manifests: [source],
    discovery: [found],
  })
}

describe('WorkPresetResolver', () => {
  it.each(['anchored-standard', 'anchored-standard-jspace'] as const)(
    'resolves the complete fixed %s preset without exposing provision internals',
    (id) => {
      const source = manifest(id)
      const resolved = resolver(source, discovery(source)).resolve(id)

      expect(resolved).toEqual({
        ...source.preset,
        compatibilityPatchVersion: source.compatibilityPatchVersion,
      })
      expect(Object.isFrozen(resolved)).toBe(true)
      expect(JSON.stringify(resolved)).not.toMatch(/(?:[A-Z]:\\|\/home\/|credentials|profilePath)/i)
    },
  )

  it.each(['unknown-profile', 'D:\\private\\preset', '../preset'])(
    'rejects unregistered ids and path-like input: %s',
    (id) => {
      expect(() => resolver().resolve(id as 'anchored-standard'))
        .toThrow(UnknownWorkPresetError)
    },
  )

  it('rejects a discovery manifest or upstream checksum mismatch', () => {
    const source = manifest()
    const mismatchedManifest = discovery(source, { manifestFingerprint: 'e'.repeat(64) })
    const mismatchedUpstream = discovery(source, {
      upstreams: source.preset.upstreams.map((upstream) => upstream.project === 'anchored-standard'
        ? { ...upstream, checksum: 'f'.repeat(64) }
        : upstream),
    })

    for (const found of [mismatchedManifest, mismatchedUpstream]) {
      expect(() => resolver(source, found).resolve(source.preset.id))
        .toThrow(expect.objectContaining({ status: 'not-ready', reason: 'manifest-mismatch' }))
    }
  })

  it.each([
    {
      label: 'license is not ready',
      source: manifest('anchored-standard', { licenseStatus: 'not-ready' }),
      found: undefined,
      reason: 'license-not-ready',
    },
    {
      label: 'provision is mutable',
      source: manifest(),
      found: discovery(manifest(), { immutableProvision: false }),
      reason: 'mutable-provision',
    },
    {
      label: 'J-Space capability is absent',
      source: manifest('anchored-standard-jspace'),
      found: discovery(manifest('anchored-standard-jspace'), { capabilities: [] }),
      reason: 'missing-capability',
    },
  ])('reports not-ready when $label', ({ source, found, reason }) => {
    const target = found ?? discovery(source)

    expect(() => resolver(source, target).resolve(source.preset.id))
      .toThrow(expect.objectContaining({ status: 'not-ready', reason }))
  })

  it('reports incompatible when the fixed preset targets another DSH build', () => {
    const source = manifest('anchored-standard', {
      dshCompatibility: { version: '0.1.0-rc.8', commit: DSH.commit },
    })

    expect(() => resolver(source, discovery(source)).resolve(source.preset.id))
      .toThrow(expect.objectContaining({ status: 'incompatible', reason: 'dsh-incompatible' }))
  })

  it('fails manifest validation when the fixed profile composition is incomplete', () => {
    const source = manifest()
    const incomplete = manifest('anchored-standard', {
      preset: {
        ...source.preset,
        upstreams: [],
      },
    })

    expect(() => resolver(incomplete, discovery(incomplete)))
      .toThrow(InvalidWorkPresetManifestError)
  })

  it('fails manifest validation instead of retaining unknown private fields', () => {
    const source: unknown = { ...manifest(), profilePath: 'D:\\private\\preset' }

    expect(() => new WorkPresetResolver({
      dshCompatibility: DSH,
      manifests: [source as WorkPresetManifestV1],
      discovery: [],
    })).toThrow(InvalidWorkPresetManifestError)
  })

  it('uses structured resolution errors for caller-visible failure semantics', () => {
    try {
      resolver(manifest(), discovery(manifest(), { immutableProvision: false }))
        .resolve('anchored-standard')
      expect.fail('Expected resolution to fail.')
    } catch (error) {
      expect(error).toBeInstanceOf(WorkPresetResolutionError)
      expect(error).toMatchObject({ status: 'not-ready', reason: 'mutable-provision' })
    }
  })
})
