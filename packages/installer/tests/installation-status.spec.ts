import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import {
  fingerprintAgentPresetDirectory,
  fingerprintInstallerArtifact,
  inspectMistyMoonInstallation,
  writeMistyMoonInstallState,
} from '../src/index.js'

const workspaceRoot = fileURLToPath(new URL('../../..', import.meta.url))

describe('inspectMistyMoonInstallation', () => {
  it('reports an absent state without scanning private product data', async () => {
    const dshHome = await mkdtemp(join(tmpdir(), 'mistymoon-status-absent-'))
    try {
      await expect(inspectMistyMoonInstallation({ dshHome })).resolves.toMatchObject({
        version: 1,
        status: 'not-installed',
        issues: ['install-state-missing'],
        statePath: join(dshHome, 'mistymoon', 'install-state.json'),
      })
    } finally {
      await rm(dshHome, { recursive: true, force: true })
    }
  })

  it('reports versioned bundle and preset paths and detects preset drift', async () => {
    const dshHome = await mkdtemp(join(tmpdir(), 'mistymoon-status-installed-'))
    try {
      const rpPresetId = 'mistymoon-rp-host-v1'
      const workPresetId = 'mistymoon-work-anchored-standard-v1'
      const rpPresetPath = join(dshHome, '.agent-presets', rpPresetId)
      const workPresetPath = join(dshHome, '.agent-presets', workPresetId)
      const bundleArchive = 'mistymoon-dsh-0.0.1-rc.5.tgz'
      const bundleArchivePath = join(dshHome, 'mistymoon', 'packages', bundleArchive)
      await cp(join(workspaceRoot, 'packages', 'foundation', 'presets', rpPresetId), rpPresetPath, { recursive: true })
      await cp(join(workspaceRoot, 'packages', 'work-agent', 'presets', workPresetId), workPresetPath, { recursive: true })
      await mkdir(join(dshHome, 'mistymoon', 'packages'), { recursive: true })
      await writeFile(bundleArchivePath, 'neutral archive fixture', 'utf8')
      const profileDir = join(dshHome, 'profiles', 'web')
      const profilePackagePath = join(profileDir, 'node_modules', '@mistymoon', 'dsh')
      await mkdir(profilePackagePath, { recursive: true })
      await writeFile(join(profileDir, 'package.json'), JSON.stringify({
        dependencies: { '@mistymoon/dsh': `file:${bundleArchivePath.replaceAll('\\', '/')}` },
      }), 'utf8')
      await writeFile(join(profilePackagePath, 'package.json'), JSON.stringify({
        name: '@mistymoon/dsh',
        version: '0.0.1-rc.5',
      }), 'utf8')
      await writeMistyMoonInstallState(dshHome, {
        version: 1,
        packageName: '@mistymoon/dsh',
        packageVersion: '0.0.1-rc.5',
        bundleArchive,
        bundleFingerprint: await fingerprintInstallerArtifact(bundleArchivePath),
        dshVersion: '0.1.0-rc.7',
        profileName: 'web',
        rpPresetId,
        rpPresetFingerprint: await fingerprintAgentPresetDirectory(rpPresetPath),
        workPresetId,
        workPresetFingerprint: await fingerprintAgentPresetDirectory(workPresetPath),
      })

      await expect(inspectMistyMoonInstallation({ dshHome })).resolves.toMatchObject({
        status: 'installed',
        issues: [],
        packageVersion: '0.0.1-rc.5',
        bundleArchivePath,
        profilePackagePath,
        rpPresetId,
        rpPresetPath,
        workPresetId,
        workPresetPath,
      })

      await writeFile(join(rpPresetPath, 'owner-drift.txt'), 'changed', 'utf8')
      await expect(inspectMistyMoonInstallation({ dshHome })).resolves.toMatchObject({
        status: 'drifted',
        issues: ['rp-preset-changed'],
      })
    } finally {
      await rm(dshHome, { recursive: true, force: true })
    }
  })
})
