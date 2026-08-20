import { describe, expect, it } from 'vitest'
import {
  getFixedWorkPresetManifests,
  WorkPresetResolutionError,
  WorkPresetResolver,
} from '../src/index.js'

const DSH = {
  version: '0.1.0-rc.7',
  commit: '99f6f02fecdb7dff40c3fbc9470f5907c29f74ca',
} as const

describe('fixed Work preset manifests', () => {
  it('publishes an audited Anchored-only default without enabling J-Space', () => {
    const manifests = getFixedWorkPresetManifests()

    expect(manifests).toEqual([
      expect.objectContaining({
        version: 1,
        licenseStatus: 'ready',
        activationStatus: 'default',
        requiredCapabilities: [],
        preset: expect.objectContaining({
          id: 'anchored-standard',
          nativePresetId: 'mistymoon-work-anchored-standard-v2',
          upstreams: [
            {
              project: 'anchored-standard',
              commit: '25f21aefaf8ddc414da54d2e581e43740d977c6e',
              checksum: 'cefdb574edf0f160e97e46bbc4c891443e4978a5334455e19918543ea323c07a',
              checksumAlgorithm: 'sha256-git-ls-tree-v1',
              delivery: 'bundled',
              licenseStatus: 'ready',
              licenseSpdx: 'MIT',
              protectedSectionsCompatibility: 'requires-policy-shield',
            },
          ],
        }),
      }),
      expect.objectContaining({
        version: 1,
        licenseStatus: 'ready',
        activationStatus: 'experimental-disabled',
        requiredCapabilities: ['j-space-experiment-enabled'],
        preset: expect.objectContaining({
          id: 'anchored-standard-jspace',
          upstreams: expect.arrayContaining([
            {
              project: 'j-space',
              commit: '27e69e29160b733143f0e52b5e8877e0485a767d',
              checksum: '7deea59e48801aaab39d5c7b7e9d6a2bdc875a14386a37f4cbee508f232e4c4f',
              checksumAlgorithm: 'sha256-git-ls-tree-v1',
              delivery: 'bundled',
              licenseStatus: 'ready',
              licenseSpdx: 'Apache-2.0',
              protectedSectionsCompatibility: 'preserves',
            },
          ]),
        }),
      }),
    ])
    expect(Object.isFrozen(manifests)).toBe(true)
    expect(manifests.every(Object.isFrozen)).toBe(true)
    expect(JSON.stringify(manifests)).not.toMatch(/(?:[A-Z]:\\|\/home\/|file:\/\/|credentials|profilePath)/i)
  })

  it('resolves Anchored without external capabilities while J-Space stays disabled', () => {
    const manifests = getFixedWorkPresetManifests()
    const resolver = new WorkPresetResolver({
      dshCompatibility: DSH,
      manifests,
      discovery: manifests.map(({ preset }) => ({
        nativePresetId: preset.nativePresetId,
        manifestFingerprint: preset.manifestFingerprint,
        upstreams: preset.upstreams,
        immutableProvision: true,
        capabilities: [],
      })),
    })

    expect(resolver.resolve('anchored-standard')).toMatchObject({
      id: 'anchored-standard',
      upstreams: [expect.objectContaining({ project: 'anchored-standard', delivery: 'bundled' })],
    })
    expect(() => resolver.resolve('anchored-standard-jspace')).toThrow(
      expect.objectContaining<Partial<WorkPresetResolutionError>>({
        status: 'not-ready',
        reason: 'missing-capability',
      }),
    )
  })
})
