import { cp, lstat, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { formatInstallationPreview, parseInstallerArguments } from '../src/cli.js'
import { applyMistyMoonInstallation, previewMistyMoonInstallation } from '../src/index.js'

const workspaceRoot = fileURLToPath(new URL('../../..', import.meta.url))

describe('published MistyMoon installer CLI', () => {
  it('requires an explicit DSH Home and shows the preset change before confirmation', () => {
    expect(() => parseInstallerArguments([], {})).toThrow(/DSH Home/i)
    expect(parseInstallerArguments([
      '--dsh-home', 'D:\\MistyFixture',
      '--dsh-root', 'D:\\DshFixture',
      '--yes',
    ], {})).toEqual({
      command: 'install',
      dshHome: 'D:\\MistyFixture',
      dshRuntimeRoot: 'D:\\DshFixture',
      ownerConfirmed: true,
    })
    expect(parseInstallerArguments([
      'update',
      '--dsh-home', 'D:\\MistyFixture',
      '--dsh-root', 'D:\\DshFixture',
    ], {})).toMatchObject({ command: 'update', ownerConfirmed: false })
    expect(parseInstallerArguments(['status', '--dsh-home', 'D:\\MistyFixture'], {}))
      .toMatchObject({ command: 'status' })
    expect(parseInstallerArguments(['rollback', '--dsh-home', 'D:\\MistyFixture'], {}))
      .toMatchObject({ command: 'rollback' })
    expect(() => parseInstallerArguments(['remove', '--dsh-home', 'D:\\MistyFixture'], {}))
      .toThrow(/command/i)

    expect(formatInstallationPreview({
      profileName: 'web',
      profilePackageStatus: 'absent',
      presetId: 'mistymoon-rp-host-v1',
      presetStatus: 'ready',
      sourceFingerprint: 'abc123',
      workPresetId: 'mistymoon-work-anchored-standard-v1',
      workPresetStatus: 'ready',
      workSourceFingerprint: 'def456',
    })).toContain([
      'DSH Profile: web',
      'Existing Profile package: none',
      'Agent preset: create mistymoon-rp-host-v1',
      'Preset source fingerprint: abc123',
      'Work preset: create mistymoon-work-anchored-standard-v1',
      'Work preset source fingerprint: def456',
    ].join('\n'))
  })

  it('rejects a malformed external DSH runtime manifest before previewing writes', async () => {
    const dshHome = await mkdtemp(join(tmpdir(), 'mistymoon-invalid-runtime-home-'))
    const runtimeRoot = await mkdtemp(join(tmpdir(), 'mistymoon-invalid-runtime-'))
    try {
      const runtimePackage = join(runtimeRoot, 'node_modules', '@deepseek-ai', 'dsh')
      await mkdir(runtimePackage, { recursive: true })
      await writeFile(join(runtimePackage, 'package.json'), JSON.stringify({ version: 7 }), 'utf8')

      await expect(previewMistyMoonInstallation({
        packageRoot: workspaceRoot,
        dshRuntimeRoot: runtimeRoot,
        dshHome,
      })).rejects.toThrow(TypeError)
      await expect(lstat(join(dshHome, 'profiles', 'web')))
        .rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await Promise.all([
        rm(dshHome, { recursive: true, force: true }),
        rm(runtimeRoot, { recursive: true, force: true }),
      ])
    }
  })

  it('previews removal of an exact stale source junction left by Profile management', async () => {
    const dshHome = await mkdtemp(join(tmpdir(), 'mistymoon-stale-profile-preview-'))
    try {
      const profileDir = join(dshHome, 'profiles', 'web')
      const packageScope = join(profileDir, 'node_modules', '@mistymoon')
      await mkdir(packageScope, { recursive: true })
      await writeFile(join(profileDir, 'package.json'), JSON.stringify({
        name: 'neutral-web-profile',
        dependencies: {},
      }), 'utf8')
      await symlink(workspaceRoot, join(packageScope, 'dsh'), 'junction')

      const plan = await previewMistyMoonInstallation({
        packageRoot: workspaceRoot,
        dshRuntimeRoot: workspaceRoot,
        dshHome,
      })

      expect(plan.profilePackage).toMatchObject({
        status: 'stale-source-link',
        requiresRemoval: true,
      })
    } finally {
      await rm(dshHome, { recursive: true, force: true })
    }
  })

  it('does not delete a preset that appears after preview when preset provisioning fails', async () => {
    const dshHome = await mkdtemp(join(tmpdir(), 'mistymoon-concurrent-preset-'))
    try {
      const plan = await previewMistyMoonInstallation({
        packageRoot: workspaceRoot,
        dshRuntimeRoot: workspaceRoot,
        dshHome,
      })
      expect(plan.status).toBe('ready')

      const target = join(dshHome, '.agent-presets', 'mistymoon-rp-host-v2')
      await mkdir(join(dshHome, '.agent-presets'), { recursive: true })
      await cp(
        join(workspaceRoot, 'packages', 'foundation', 'presets', 'mistymoon-rp-host-v2'),
        target,
        { recursive: true },
      )

      await expect(applyMistyMoonInstallation(plan, { ownerConfirmed: true }))
        .rejects.toMatchObject({ reason: 'target-exists' })
      const stat = await lstat(target)
      expect(stat.isDirectory()).toBe(true)
    } finally {
      await rm(dshHome, { recursive: true, force: true })
    }
  })
})
