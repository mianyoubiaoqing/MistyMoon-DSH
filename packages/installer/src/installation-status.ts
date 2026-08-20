import { lstat, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { installStatePath, readMistyMoonInstallState } from './install-state.js'
import { fingerprintAgentPresetDirectory } from './work-preset-provisioner.js'
import { fingerprintInstallerArtifact } from './artifact-fingerprint.js'

/** Drift reasons reported without reading Persona, Memory, sessions, or logs. */
export type MistyMoonInstallationIssueV1 =
  | 'install-state-missing'
  | 'bundle-archive-missing'
  | 'bundle-archive-changed'
  | 'profile-package-missing'
  | 'profile-package-changed'
  | 'rp-preset-missing'
  | 'rp-preset-changed'
  | 'work-preset-missing'
  | 'work-preset-changed'

/** Content-free status suitable for the published `status` command. */
export interface MistyMoonInstallationStatusV1 {
  readonly version: 1
  readonly status: 'not-installed' | 'installed' | 'drifted'
  readonly statePath: string
  readonly issues: readonly MistyMoonInstallationIssueV1[]
  readonly packageVersion?: string
  readonly dshVersion?: string
  readonly bundleArchivePath?: string
  readonly bundleFingerprint?: string
  readonly profilePackagePath?: string
  readonly rpPresetId?: string
  readonly rpPresetPath?: string
  readonly rpPresetFingerprint?: string
  readonly workPresetId?: string
  readonly workPresetPath?: string
  readonly workPresetFingerprint?: string
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

async function presetIssue(
  path: string,
  expectedFingerprint: string,
  missing: MistyMoonInstallationIssueV1,
  changed: MistyMoonInstallationIssueV1,
): Promise<MistyMoonInstallationIssueV1 | undefined> {
  if (!(await pathExists(path))) return missing
  try {
    return await fingerprintAgentPresetDirectory(path) === expectedFingerprint ? undefined : changed
  } catch {
    return changed
  }
}

/** Inspect only installer-owned state, bundle cache, and versioned preset assets. */
export async function inspectMistyMoonInstallation(
  options: { readonly dshHome: string },
): Promise<MistyMoonInstallationStatusV1> {
  const statePath = installStatePath(options.dshHome)
  const state = await readMistyMoonInstallState(options.dshHome)
  if (state === undefined) {
    return Object.freeze({
      version: 1,
      status: 'not-installed',
      statePath,
      issues: Object.freeze(['install-state-missing'] as const),
    })
  }
  const bundleArchivePath = join(options.dshHome, 'mistymoon', 'packages', state.bundleArchive)
  const profileDir = join(options.dshHome, 'profiles', 'web')
  const profilePackagePath = join(profileDir, 'node_modules', '@mistymoon', 'dsh')
  const rpPresetPath = join(options.dshHome, '.agent-presets', state.rpPresetId)
  const workPresetPath = join(options.dshHome, '.agent-presets', state.workPresetId)
  const issues: MistyMoonInstallationIssueV1[] = []
  if (!(await pathExists(bundleArchivePath))) issues.push('bundle-archive-missing')
  else if (await fingerprintInstallerArtifact(bundleArchivePath) !== state.bundleFingerprint) {
    issues.push('bundle-archive-changed')
  }
  const profileManifestPath = join(profileDir, 'package.json')
  const installedManifestPath = join(profilePackagePath, 'package.json')
  if (!(await pathExists(profileManifestPath)) || !(await pathExists(installedManifestPath))) {
    issues.push('profile-package-missing')
  } else {
    try {
      const profileManifest = JSON.parse(await readFile(profileManifestPath, 'utf8')) as unknown
      const installedManifest = JSON.parse(await readFile(installedManifestPath, 'utf8')) as unknown
      const dependency = typeof profileManifest === 'object' && profileManifest !== null
        ? (profileManifest as { dependencies?: Record<string, unknown> }).dependencies?.['@mistymoon/dsh']
        : undefined
      const installedName = typeof installedManifest === 'object' && installedManifest !== null
        ? (installedManifest as { name?: unknown }).name
        : undefined
      const installedVersion = typeof installedManifest === 'object' && installedManifest !== null
        ? (installedManifest as { version?: unknown }).version
        : undefined
      const dependencyPath = typeof dependency === 'string' && dependency.startsWith('file:')
        ? resolve(dependency.slice('file:'.length))
        : undefined
      const normalize = (path: string) => process.platform === 'win32' ? path.toLowerCase() : path
      if (dependencyPath === undefined
        || normalize(dependencyPath) !== normalize(resolve(bundleArchivePath))
        || installedName !== '@mistymoon/dsh'
        || installedVersion !== state.packageVersion) {
        issues.push('profile-package-changed')
      }
    } catch {
      issues.push('profile-package-changed')
    }
  }
  const rpIssue = await presetIssue(
    rpPresetPath,
    state.rpPresetFingerprint,
    'rp-preset-missing',
    'rp-preset-changed',
  )
  if (rpIssue !== undefined) issues.push(rpIssue)
  const workIssue = await presetIssue(
    workPresetPath,
    state.workPresetFingerprint,
    'work-preset-missing',
    'work-preset-changed',
  )
  if (workIssue !== undefined) issues.push(workIssue)
  return Object.freeze({
    version: 1,
    status: issues.length === 0 ? 'installed' : 'drifted',
    statePath,
    issues: Object.freeze(issues),
    packageVersion: state.packageVersion,
    dshVersion: state.dshVersion,
    bundleArchivePath,
    bundleFingerprint: state.bundleFingerprint,
    profilePackagePath,
    rpPresetId: state.rpPresetId,
    rpPresetPath,
    rpPresetFingerprint: state.rpPresetFingerprint,
    workPresetId: state.workPresetId,
    workPresetPath,
    workPresetFingerprint: state.workPresetFingerprint,
  })
}
