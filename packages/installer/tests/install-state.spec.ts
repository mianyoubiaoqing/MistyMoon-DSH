import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  installStatePath,
  readMistyMoonInstallState,
  writeMistyMoonInstallState,
  type MistyMoonInstallStateV1,
} from '../src/install-state.js'

const state: MistyMoonInstallStateV1 = {
  version: 1,
  packageName: '@mistymoon/dsh',
  packageVersion: '0.0.1-rc.6',
  bundleArchive: 'mistymoon-dsh-0.0.1-rc.6.tgz',
  bundleFingerprint: 'e'.repeat(64),
  dshVersion: '0.1.0-rc.7',
  profileName: 'web',
  rpPresetId: 'mistymoon-rp-host-v2',
  rpPresetFingerprint: 'a'.repeat(64),
  workPresetId: 'mistymoon-work-anchored-standard-v2',
  workPresetFingerprint: 'b'.repeat(64),
  previous: {
    packageVersion: '0.0.1-rc.5',
    bundleArchive: 'mistymoon-dsh-0.0.1-rc.5.tgz',
    bundleFingerprint: 'f'.repeat(64),
    rpPresetId: 'mistymoon-rp-host-v1',
    rpPresetFingerprint: 'c'.repeat(64),
    workPresetId: 'mistymoon-work-anchored-standard-v1',
    workPresetFingerprint: 'd'.repeat(64),
  },
}

describe('MistyMoon install state', () => {
  it('publishes and reads a strictly validated content-free state atomically', async () => {
    const dshHome = await mkdtemp(join(tmpdir(), 'mistymoon-install-state-'))
    try {
      await writeMistyMoonInstallState(dshHome, state)

      await expect(readMistyMoonInstallState(dshHome)).resolves.toEqual(state)
      await expect(readFile(installStatePath(dshHome), 'utf8'))
        .resolves.toBe(`${JSON.stringify(state, null, 2)}\n`)
    } finally {
      await rm(dshHome, { recursive: true, force: true })
    }
  })

  it('returns undefined only when the state file is absent', async () => {
    const dshHome = await mkdtemp(join(tmpdir(), 'mistymoon-install-state-absent-'))
    try {
      await expect(readMistyMoonInstallState(dshHome)).resolves.toBeUndefined()
    } finally {
      await rm(dshHome, { recursive: true, force: true })
    }
  })

  it.each([
    ['unknown version', { ...state, version: 2 }],
    ['wrong package', { ...state, packageName: '@neutral/example' }],
    ['unsafe archive name', { ...state, bundleArchive: '../private.tgz' }],
    ['invalid fingerprint', { ...state, rpPresetFingerprint: 'private-content' }],
    ['unknown field', { ...state, persona: 'must never be stored' }],
  ])('rejects %s instead of guessing', async (_label, invalid) => {
    const dshHome = await mkdtemp(join(tmpdir(), 'mistymoon-install-state-invalid-'))
    try {
      const path = installStatePath(dshHome)
      await writeMistyMoonInstallState(dshHome, state)
      await writeFile(path, `${JSON.stringify(invalid)}\n`, 'utf8')

      await expect(readMistyMoonInstallState(dshHome)).rejects.toThrow('install state')
    } finally {
      await rm(dshHome, { recursive: true, force: true })
    }
  })
})
