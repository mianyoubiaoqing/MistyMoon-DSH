import { execFileSync } from 'node:child_process'
import { cp, copyFile, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  applyMistyMoonInstallation,
  dumpProfile,
  packProfileBundle,
  packPublishedProfileBundle,
  previewMistyMoonRollback,
  previewMistyMoonUpdate,
  applyMistyMoonRollback,
  previewMistyMoonInstallation,
  resolvePreviewHome,
  smokeProfile,
} from '../src/index.js'
import { readMistyMoonInstallState } from '../src/install-state.js'

const workspaceRoot = fileURLToPath(new URL('../../..', import.meta.url))
let sharedBundleArchive: string
let sharedInstalledHome: string
let sharedPublishedPackageRoot: string
let sharedBundleRoot: string
let sharedExtractedRoot: string

beforeAll(async () => {
  sharedBundleRoot = await mkdtemp(join(tmpdir(), 'mistymoon-installer-bundle-'))
  sharedBundleArchive = await packProfileBundle({
    workspaceRoot,
    outputPath: join(sharedBundleRoot, 'mistymoon-dsh.tgz'),
  })
  sharedExtractedRoot = await mkdtemp(join(tmpdir(), 'mistymoon-installer-published-'))
  execFileSync('tar', ['-xf', sharedBundleArchive, '-C', sharedExtractedRoot])
  sharedPublishedPackageRoot = join(sharedExtractedRoot, 'package')
  sharedInstalledHome = await mkdtemp(join(tmpdir(), 'mistymoon-dsh-shared-home-'))
  const plan = await previewMistyMoonInstallation({
    packageRoot: sharedPublishedPackageRoot,
    dshRuntimeRoot: workspaceRoot,
    dshHome: sharedInstalledHome,
    bundleArchivePath: sharedBundleArchive,
  })
  await applyMistyMoonInstallation(plan, { ownerConfirmed: true })
}, 180_000)

afterAll(async () => {
  await Promise.all([
    rm(sharedBundleRoot, { recursive: true, force: true }),
    rm(sharedExtractedRoot, { recursive: true, force: true }),
    rm(sharedInstalledHome, { recursive: true, force: true }),
  ])
})

describe('resolvePreviewHome', () => {
  it('uses an explicit private home before the dedicated Windows data directory', () => {
    expect(resolvePreviewHome({
      env: {
        LOCALAPPDATA: 'C:\\Users\\Owner\\AppData\\Local',
        MISTYMOON_DSH_HOME: 'D:\\MistyPrivate',
      },
      homeDirectory: 'C:\\Users\\Owner',
      platform: 'win32',
    })).toBe('D:\\MistyPrivate')

    expect(resolvePreviewHome({
      env: { LOCALAPPDATA: 'C:\\Users\\Owner\\AppData\\Local' },
      homeDirectory: 'C:\\Users\\Owner',
      platform: 'win32',
    })).toBe('C:\\Users\\Owner\\AppData\\Local\\MistyMoon\\dsh')
  })
})

describe('MistyMoon installation', () => {
  it('replaces an exact stale source junction without requiring Windows directory-symlink privilege', async () => {
    const dshHome = await mkdtemp(join(tmpdir(), 'mistymoon-stale-profile-home-'))
    try {
      execFileSync(process.execPath, [
        join(workspaceRoot, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
        'plugin',
        '--profile',
        'web',
        'why',
        '__neutral_probe__',
      ], {
        cwd: workspaceRoot,
        env: { ...process.env, DSH_HOME: dshHome },
        stdio: 'ignore',
      })
      const packageScope = join(dshHome, 'profiles', 'web', 'node_modules', '@mistymoon')
      const stalePackage = join(packageScope, 'dsh')
      await mkdir(packageScope, { recursive: true })
      await symlink(workspaceRoot, stalePackage, 'junction')

      const plan = await previewMistyMoonInstallation({
        packageRoot: workspaceRoot,
        dshRuntimeRoot: workspaceRoot,
        dshHome,
        bundleArchivePath: sharedBundleArchive,
      })
      expect(plan.profilePackage.status).toBe('stale-source-link')

      const installed = await applyMistyMoonInstallation(plan, { ownerConfirmed: true })

      expect((await lstat(join(installed.profileDir, 'node_modules', '@mistymoon', 'dsh'))).isSymbolicLink())
        .toBe(false)
      await expect(readFile(join(installed.presetDir, 'preset.yml'), 'utf8'))
        .resolves.toContain('MistyMoon RP Host')
    } finally {
      await rm(dshHome, { recursive: true, force: true })
    }
  }, 120_000)

  it('replaces the previous bundle-archive declaration left by MistyMoon itself', async () => {
    const dshHome = await mkdtemp(join(tmpdir(), 'mistymoon-bundle-archive-home-'))
    try {
      const profileDir = join(dshHome, 'profiles', 'web')
      await mkdir(join(profileDir, 'node_modules', '@mistymoon'), { recursive: true })
      const previousArchive = join(dshHome, 'mistymoon', 'packages', 'mistymoon-dsh.tgz')
      await mkdir(join(dshHome, 'mistymoon', 'packages'), { recursive: true })
      await copyFile(sharedBundleArchive, previousArchive)
      await writeFile(join(profileDir, 'package.json'), JSON.stringify({
        name: 'dsh-profile-web',
        private: true,
        dependencies: {
          '@mistymoon/dsh': `file:${previousArchive.replaceAll('\\', '/')}`,
        },
        dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@mistymoon/dsh'] } },
      }, null, 2), 'utf8')

      const reinstallPlan = await previewMistyMoonInstallation({
        packageRoot: sharedPublishedPackageRoot,
        dshRuntimeRoot: workspaceRoot,
        dshHome,
        bundleArchivePath: sharedBundleArchive,
      })
      expect(reinstallPlan.status).toBe('ready')
      expect(reinstallPlan.profilePackage).toMatchObject({
        status: 'declared-bundle-archive',
        requiresRemoval: true,
      })

      const reinstalled = await applyMistyMoonInstallation(reinstallPlan, { ownerConfirmed: true })
      await expect(readFile(
        join(reinstalled.profileDir, 'node_modules', '@mistymoon', 'dsh', 'cordis.patch.yml'),
        'utf8',
      )).resolves.toContain("name: '@mistymoon/dsh/foundation'")
      await expect(readFile(join(reinstalled.presetDir, 'preset.yml'), 'utf8'))
        .resolves.toContain('MistyMoon RP Host')
    } finally {
      await rm(dshHome, { recursive: true, force: true })
    }
  }, 180_000)

  it('restores the reviewed Profile package when the replacement add fails', async () => {
    const dshHome = await mkdtemp(join(tmpdir(), 'mistymoon-profile-add-fault-home-'))
    try {
      const previousArchive = join(dshHome, 'mistymoon', 'packages', 'mistymoon-dsh.tgz')
      await mkdir(join(dshHome, 'mistymoon', 'packages'), { recursive: true })
      await copyFile(sharedBundleArchive, previousArchive)
      execFileSync(process.execPath, [
        join(workspaceRoot, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
        'plugin',
        '--profile',
        'web',
        'add',
        previousArchive,
        '--ignore-scripts',
      ], {
        cwd: workspaceRoot,
        env: { ...process.env, DSH_HOME: dshHome },
        stdio: 'ignore',
      })
      const invalidArchive = join(dshHome, 'mistymoon', 'packages', 'invalid-replacement.tgz')
      await writeFile(invalidArchive, 'not a package archive', 'utf8')

      const plan = await previewMistyMoonInstallation({
        packageRoot: sharedPublishedPackageRoot,
        dshRuntimeRoot: workspaceRoot,
        dshHome,
        bundleArchivePath: invalidArchive,
      })
      expect(plan.profilePackage.status).toBe('declared-bundle-archive')

      await expect(applyMistyMoonInstallation(plan, { ownerConfirmed: true })).rejects.toThrow()

      const manifest = JSON.parse(await readFile(join(dshHome, 'profiles', 'web', 'package.json'), 'utf8')) as {
        dependencies?: Record<string, string>
        dsh?: { profile?: { bundles?: string[] } }
      }
      expect(manifest.dependencies?.['@mistymoon/dsh']).toBe(`file:${previousArchive.replaceAll('\\', '/')}`)
      expect(manifest.dsh?.profile?.bundles).toContain('@mistymoon/dsh')
      await expect(readFile(
        join(dshHome, 'profiles', 'web', 'node_modules', '@mistymoon', 'dsh', 'cordis.patch.yml'),
        'utf8',
      )).resolves.toContain("name: '@mistymoon/dsh/foundation'")
      await expect(lstat(join(dshHome, '.agent-presets', 'mistymoon-rp-host-v2')))
        .rejects.toMatchObject({ code: 'ENOENT' })
      await expect(lstat(join(dshHome, '.agent-presets', 'mistymoon-work-anchored-standard-v2')))
        .rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(dshHome, { recursive: true, force: true })
    }
  }, 180_000)

  it('preserves the original add failure when first-install cleanup also fails', async () => {
    const dshHome = await mkdtemp(join(tmpdir(), 'mistymoon-profile-double-fault-home-'))
    const runtimeRoot = await mkdtemp(join(tmpdir(), 'mistymoon-profile-fault-runtime-'))
    try {
      const runtimePackage = join(runtimeRoot, 'node_modules', '@deepseek-ai', 'dsh')
      await mkdir(join(runtimePackage, 'lib'), { recursive: true })
      await writeFile(join(runtimePackage, 'package.json'), JSON.stringify({
        name: '@deepseek-ai/dsh',
        version: '0.1.0-rc.7',
        type: 'module',
      }), 'utf8')
      await writeFile(join(runtimePackage, 'lib', 'bin.js'), [
        "const operation = process.argv.includes('remove') ? 'remove' : 'add'",
        "process.stderr.write(`profile-${operation}-fault`) ",
        "process.exit(operation === 'remove' ? 42 : 41)",
      ].join('\n'), 'utf8')

      const invalidArchive = join(runtimeRoot, 'neutral-replacement.tgz')
      await writeFile(invalidArchive, 'not a package archive', 'utf8')
      const plan = await previewMistyMoonInstallation({
        packageRoot: sharedPublishedPackageRoot,
        dshRuntimeRoot: runtimeRoot,
        dshHome,
        bundleArchivePath: invalidArchive,
      })

      let failure: unknown
      try {
        await applyMistyMoonInstallation(plan, { ownerConfirmed: true })
      } catch (error) {
        failure = error
      }
      expect(failure).toBeInstanceOf(AggregateError)
      const aggregate = failure as AggregateError
      expect(aggregate.cause).toBeInstanceOf(Error)
      expect((aggregate.cause as Error).message).toContain('exit code 41')
      expect(aggregate.errors).toHaveLength(2)
      expect(String(aggregate.errors[1])).toContain('exit code 42')
      await expect(lstat(join(dshHome, '.agent-presets', 'mistymoon-rp-host-v2')))
        .rejects.toMatchObject({ code: 'ENOENT' })
      await expect(lstat(join(dshHome, '.agent-presets', 'mistymoon-work-anchored-standard-v2')))
        .rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await Promise.all([
        rm(dshHome, { recursive: true, force: true }),
        rm(runtimeRoot, { recursive: true, force: true }),
      ])
    }
  })

  it('re-packs the executable published package before DSH installs it', async () => {
    const dshHome = await mkdtemp(join(tmpdir(), 'mistymoon-published-cli-home-'))
    const plan = await previewMistyMoonInstallation({
      packageRoot: sharedPublishedPackageRoot,
      packageRootIsPublishedBundle: true,
      dshRuntimeRoot: workspaceRoot,
      dshHome,
    })

    const result = await applyMistyMoonInstallation(plan, { ownerConfirmed: true })

    expect((await lstat(join(dshHome, 'mistymoon', 'packages', 'mistymoon-dsh-0.0.1-rc.6.tgz'))).isFile())
      .toBe(true)
    await expect(readFile(join(result.profileDir, 'node_modules', '@mistymoon', 'dsh', 'packages', 'installer', 'lib', 'cli.js'), 'utf8'))
      .resolves.toContain('this bundle and preset selection?')
    await rm(dshHome, { recursive: true, force: true })
  }, 120_000)

  it('refuses a foreign file dependency as an unreviewed package', async () => {
    const dshHome = await mkdtemp(join(tmpdir(), 'mistymoon-foreign-archive-home-'))
    try {
      const profileDir = join(dshHome, 'profiles', 'web')
      await mkdir(join(profileDir, 'node_modules', '@mistymoon'), { recursive: true })
      await writeFile(join(profileDir, 'package.json'), JSON.stringify({
        name: 'neutral-web-profile',
        dependencies: {
          '@mistymoon/dsh': `file:${join(tmpdir(), 'neutral-foreign-bundle.tgz')}`,
        },
      }), 'utf8')

      const plan = await previewMistyMoonInstallation({
        packageRoot: workspaceRoot,
        dshRuntimeRoot: workspaceRoot,
        dshHome,
      })

      expect(plan.status).toBe('profile-conflict')
      expect(plan.profilePackage).toMatchObject({
        status: 'conflict',
        requiresRemoval: false,
      })
      await expect(applyMistyMoonInstallation(plan, { ownerConfirmed: true }))
        .rejects.toMatchObject({ reason: 'profile-conflict' })
      await expect(readFile(join(profileDir, 'package.json'), 'utf8'))
        .resolves.toContain('neutral-foreign-bundle.tgz')
    } finally {
      await rm(dshHome, { recursive: true, force: true })
    }
  })

  it('previews one confirmed operation that installs the packed bundle, RP Host, and Work presets', async () => {
    const dshHome = await mkdtemp(join(tmpdir(), 'mistymoon-dsh-home-'))

    const plan = await previewMistyMoonInstallation({
      packageRoot: sharedPublishedPackageRoot,
      dshRuntimeRoot: workspaceRoot,
      dshHome,
      bundleArchivePath: sharedBundleArchive,
    })

    expect(plan).toMatchObject({
      version: 1,
      status: 'ready',
      requiresOwnerConfirmation: true,
      profileName: 'web',
      preset: {
        nativePresetId: 'mistymoon-rp-host-v2',
        status: 'ready',
      },
      workPreset: {
        nativePresetId: 'mistymoon-work-anchored-standard-v2',
        status: 'ready',
      },
    })
    await expect(lstat(join(dshHome, 'profiles', 'web'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(lstat(join(dshHome, '.agent-presets', 'mistymoon-rp-host-v2')))
      .rejects.toMatchObject({ code: 'ENOENT' })
    await expect(lstat(join(dshHome, '.agent-presets', 'mistymoon-work-anchored-standard-v2')))
      .rejects.toMatchObject({ code: 'ENOENT' })
    await expect(applyMistyMoonInstallation(plan, { ownerConfirmed: false }))
      .rejects.toMatchObject({ reason: 'confirmation-required' })

    const result = await applyMistyMoonInstallation(plan, { ownerConfirmed: true })

    expect(result).toEqual({
      dshHome,
      dshVersion: '0.1.0-rc.7',
      profileDir: join(dshHome, 'profiles', 'web'),
      presetDir: join(dshHome, '.agent-presets', 'mistymoon-rp-host-v2'),
      presetId: 'mistymoon-rp-host-v2',
      workPresetDir: join(dshHome, '.agent-presets', 'mistymoon-work-anchored-standard-v2'),
      workPresetId: 'mistymoon-work-anchored-standard-v2',
    })
    await expect(readMistyMoonInstallState(dshHome)).resolves.toEqual({
      version: 1,
      packageName: '@mistymoon/dsh',
      packageVersion: '0.0.1-rc.6',
      bundleArchive: 'mistymoon-dsh-0.0.1-rc.6.tgz',
      bundleFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      dshVersion: '0.1.0-rc.7',
      profileName: 'web',
      rpPresetId: 'mistymoon-rp-host-v2',
      rpPresetFingerprint: plan.preset.sourceFingerprint,
      workPresetId: 'mistymoon-work-anchored-standard-v2',
      workPresetFingerprint: plan.workPreset.sourceFingerprint,
    })
    const manifest = JSON.parse(await readFile(join(result.profileDir, 'package.json'), 'utf8')) as {
      name?: string
      dependencies?: Record<string, string>
      dsh?: { profile?: { bundles?: string[] } }
    }
    expect(manifest.name).toBe('dsh-profile-web')
    expect(manifest.dsh?.profile?.bundles).toEqual([
      '@deepseek-ai/dsh-base',
      '@deepseek-ai/dsh-web-app',
      '@mistymoon/dsh',
    ])
    expect(Object.keys(manifest.dependencies ?? {})).toEqual(['@mistymoon/dsh'])
    await expect(readFile(join(result.profileDir, 'node_modules', '@mistymoon', 'dsh', 'cordis.patch.yml'), 'utf8'))
      .resolves.toContain("name: '@mistymoon/dsh/foundation'")
    await expect(readFile(join(result.profileDir, 'node_modules', '@mistymoon', 'dsh', 'packages', 'identity', 'lib', 'index.js'), 'utf8'))
      .resolves.toContain('mistymoon-identity')
    await expect(readFile(join(result.profileDir, 'node_modules', '@mistymoon', 'dsh', 'packages', 'memory', 'lib', 'index.js'), 'utf8'))
      .resolves.toContain('mistymoon-memory')
    await expect(readFile(join(result.profileDir, 'node_modules', '@mistymoon', 'dsh', 'packages', 'work-agent-dsh', 'lib', 'index.js'), 'utf8'))
      .resolves.toContain('createFreshWorkActivation')
    await expect(readFile(join(result.presetDir, 'preset.yml'), 'utf8'))
      .resolves.toContain('MistyMoon RP Host')
    await expect(readFile(join(result.presetDir, 'agent.cordis.yml'), 'utf8'))
      .resolves.toContain('mistymoon-rp-host-composition')
    await expect(readFile(join(result.workPresetDir, 'agent.cordis.yml'), 'utf8'))
      .resolves.toContain('@deepseek-ai/dsh-persona')
    await expect(readFile(join(result.workPresetDir, 'preset.yml'), 'utf8'))
      .resolves.toContain('MistyMoon Anchored Standard Work')

    const ownerPatch = '# owner override\n[]\n'
    const personaPath = join(dshHome, 'mistymoon', 'persona', 'persona.json')
    await writeFile(join(result.profileDir, 'cordis.patch.yml'), ownerPatch, 'utf8')
    await mkdir(join(dshHome, 'mistymoon', 'persona'), { recursive: true })
    await writeFile(personaPath, '{"owner":"private"}\n', 'utf8')

    const repeatedPlan = await previewMistyMoonInstallation({
      packageRoot: sharedPublishedPackageRoot,
      dshRuntimeRoot: workspaceRoot,
      dshHome,
      bundleArchivePath: sharedBundleArchive,
    })
    expect(repeatedPlan.status).toBe('target-exists')
    await expect(applyMistyMoonInstallation(repeatedPlan, { ownerConfirmed: true }))
      .rejects.toMatchObject({ reason: 'target-exists' })

    await expect(readFile(join(result.profileDir, 'cordis.patch.yml'), 'utf8')).resolves.toBe(ownerPatch)
    await expect(readFile(personaPath, 'utf8')).resolves.toBe('{"owner":"private"}\n')
  }, 240_000)

  it('updates an exact legacy rc.5 install to rc.6, retains v1, and rolls back without overwriting presets', async () => {
    const dshHome = await mkdtemp(join(tmpdir(), 'mistymoon-versioned-update-home-'))
    const legacyRoot = await mkdtemp(join(tmpdir(), 'mistymoon-legacy-package-'))
    try {
      const legacyPackageRoot = join(legacyRoot, 'package')
      await cp(sharedPublishedPackageRoot, legacyPackageRoot, { recursive: true })
      const legacyManifestPath = join(legacyPackageRoot, 'package.json')
      const legacyManifest = JSON.parse(await readFile(legacyManifestPath, 'utf8')) as Record<string, unknown>
      legacyManifest.version = '0.0.1-rc.5'
      await writeFile(legacyManifestPath, `${JSON.stringify(legacyManifest, null, 2)}\n`, 'utf8')
      const packageCache = join(dshHome, 'mistymoon', 'packages')
      const legacyArchive = join(packageCache, 'mistymoon-dsh.tgz')
      await packPublishedProfileBundle(legacyPackageRoot, legacyArchive)

      const profileDir = join(dshHome, 'profiles', 'web')
      const installedLegacyRoot = join(profileDir, 'node_modules', '@mistymoon', 'dsh')
      await mkdir(join(profileDir, 'node_modules', '@mistymoon'), { recursive: true })
      await cp(legacyPackageRoot, installedLegacyRoot, { recursive: true })
      await writeFile(join(profileDir, 'package.json'), JSON.stringify({
        name: 'dsh-profile-web',
        private: true,
        dependencies: { '@mistymoon/dsh': `file:${legacyArchive.replaceAll('\\', '/')}` },
        dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@mistymoon/dsh'] } },
      }, null, 2), 'utf8')
      const presetRoot = join(dshHome, '.agent-presets')
      await mkdir(presetRoot, { recursive: true })
      await cp(
        join(legacyPackageRoot, 'packages', 'foundation', 'presets', 'mistymoon-rp-host-v1'),
        join(presetRoot, 'mistymoon-rp-host-v1'),
        { recursive: true },
      )
      await cp(
        join(legacyPackageRoot, 'packages', 'work-agent', 'presets', 'mistymoon-work-anchored-standard-v1'),
        join(presetRoot, 'mistymoon-work-anchored-standard-v1'),
        { recursive: true },
      )

      const updatePlan = await previewMistyMoonUpdate({
        packageRoot: sharedPublishedPackageRoot,
        packageRootIsPublishedBundle: true,
        dshRuntimeRoot: workspaceRoot,
        dshHome,
        bundleArchivePath: sharedBundleArchive,
      })
      expect(updatePlan).toMatchObject({
        action: 'update',
        status: 'ready',
        packageVersion: '0.0.1-rc.6',
        currentState: {
          packageVersion: '0.0.1-rc.5',
          rpPresetId: 'mistymoon-rp-host-v1',
          workPresetId: 'mistymoon-work-anchored-standard-v1',
        },
        preset: { nativePresetId: 'mistymoon-rp-host-v2' },
        workPreset: { nativePresetId: 'mistymoon-work-anchored-standard-v2' },
      })

      await applyMistyMoonInstallation(updatePlan, { ownerConfirmed: true })
      const updatedState = await readMistyMoonInstallState(dshHome)
      expect(updatedState).toMatchObject({
        packageVersion: '0.0.1-rc.6',
        rpPresetId: 'mistymoon-rp-host-v2',
        workPresetId: 'mistymoon-work-anchored-standard-v2',
        previous: {
          packageVersion: '0.0.1-rc.5',
          rpPresetId: 'mistymoon-rp-host-v1',
          workPresetId: 'mistymoon-work-anchored-standard-v1',
        },
      })
      await expect(lstat(join(presetRoot, 'mistymoon-rp-host-v1'))).resolves.toBeDefined()
      await expect(lstat(join(presetRoot, 'mistymoon-rp-host-v2'))).resolves.toBeDefined()

      const rollbackPlan = await previewMistyMoonRollback({
        packageRoot: sharedPublishedPackageRoot,
        dshRuntimeRoot: workspaceRoot,
        dshHome,
      })
      await applyMistyMoonRollback(rollbackPlan, { ownerConfirmed: true })

      await expect(readMistyMoonInstallState(dshHome)).resolves.toMatchObject({
        packageVersion: '0.0.1-rc.5',
        rpPresetId: 'mistymoon-rp-host-v1',
        workPresetId: 'mistymoon-work-anchored-standard-v1',
        previous: {
          packageVersion: '0.0.1-rc.6',
          rpPresetId: 'mistymoon-rp-host-v2',
          workPresetId: 'mistymoon-work-anchored-standard-v2',
        },
      })
      const rolledBackManifest = JSON.parse(await readFile(
        join(profileDir, 'node_modules', '@mistymoon', 'dsh', 'package.json'),
        'utf8',
      )) as { version?: string }
      expect(rolledBackManifest.version).toBe('0.0.1-rc.5')
      await expect(lstat(join(presetRoot, 'mistymoon-rp-host-v2'))).resolves.toBeDefined()
    } finally {
      await Promise.all([
        rm(dshHome, { recursive: true, force: true }),
        rm(legacyRoot, { recursive: true, force: true }),
      ])
    }
  }, 300_000)

  it('compensates bundle and both presets when final install-state publication fails', async () => {
    const dshHome = await mkdtemp(join(tmpdir(), 'mistymoon-state-publish-fault-'))
    try {
      const plan = await previewMistyMoonInstallation({
        packageRoot: sharedPublishedPackageRoot,
        dshRuntimeRoot: workspaceRoot,
        dshHome,
        bundleArchivePath: sharedBundleArchive,
      })
      await mkdir(join(dshHome, 'mistymoon', 'install-state.json'), { recursive: true })

      await expect(applyMistyMoonInstallation(plan, { ownerConfirmed: true })).rejects.toThrow()

      await expect(lstat(join(dshHome, '.agent-presets', 'mistymoon-rp-host-v2')))
        .rejects.toMatchObject({ code: 'ENOENT' })
      await expect(lstat(join(dshHome, '.agent-presets', 'mistymoon-work-anchored-standard-v2')))
        .rejects.toMatchObject({ code: 'ENOENT' })
      await expect(lstat(join(dshHome, 'mistymoon', 'packages', 'mistymoon-dsh-0.0.1-rc.6.tgz')))
        .rejects.toMatchObject({ code: 'ENOENT' })
      await expect(lstat(join(dshHome, 'profiles', 'web', 'node_modules', '@mistymoon', 'dsh')))
        .rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(dshHome, { recursive: true, force: true })
    }
  }, 180_000)
})

describe('dumpProfile', () => {
  it('is parsed by the repository-pinned DSH runtime', async () => {
    const output = await dumpProfile({ workspaceRoot, dshHome: sharedInstalledHome })

    expect(output).toContain('id: mistymoon-foundation')
    expect(output).toContain('id: mistymoon-identity')
    expect(output).toContain("name: '@mistymoon/dsh/foundation'")
  }, 120_000)
})

describe('smokeProfile', () => {
  it('activates the packed foundation through DSH without binding a web server', async () => {
    const output = await smokeProfile({ workspaceRoot, dshHome: sharedInstalledHome })

    expect(output).toContain('Usage: dsh --profile web')
    const persona = JSON.parse(await readFile(join(sharedInstalledHome, 'mistymoon', 'persona', 'persona.json'), 'utf8')) as {
      kind?: string
    }
    expect(persona.kind).toBe('mistymoon.persona')
  }, 120_000)
})
