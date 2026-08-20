/**
 * Development preview installation for the MistyMoon DSH profile.
 * @module @mistymoon/dsh-installer
 */

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { constants, existsSync } from 'node:fs'
import { copyFile, lstat, mkdir, open, readFile, realpath, rename, rm, symlink, unlink } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'

import {
  applyAgentPresetProvision,
  compensateAgentPresetProvision,
  previewAgentPresetProvision,
  WorkPresetProvisionError,
  fingerprintAgentPresetDirectory,
  type AgentPresetProvisionPlanV1,
} from './work-preset-provisioner.js'
import {
  readMistyMoonInstallState,
  writeMistyMoonInstallState,
  type MistyMoonInstallStateV1,
} from './install-state.js'
import { inspectMistyMoonInstallation } from './installation-status.js'
import { fingerprintInstallerArtifact } from './artifact-fingerprint.js'

export * from './work-preset-provisioner.js'
export * from './install-state.js'
export * from './installation-status.js'
export * from './artifact-fingerprint.js'

const PROFILE_NAME = 'web'
const RP_HOST_PRESET_ID = 'mistymoon-rp-host-v2'
const WORK_PRESET_ID = 'mistymoon-work-anchored-standard-v2'
const BUNDLE_ARCHIVE_NAME = /^mistymoon-dsh(?:-[0-9A-Za-z][0-9A-Za-z.+-]*)?\.tgz$/

/** Inputs for selecting the preview's private DSH home. */
export interface ResolvePreviewHomeOptions {
  /** Environment containing optional explicit and platform data locations. */
  env: NodeJS.ProcessEnv
  /** Current operating system. */
  platform: NodeJS.Platform
  /** Current account home used only when the platform data location is absent. */
  homeDirectory: string
}

/**
 * Select a dedicated private DSH home without placing runtime data in the repository.
 * @param options - Environment and platform location inputs.
 * @returns Explicit override or platform-specific MistyMoon data directory.
 */
export function resolvePreviewHome(options: ResolvePreviewHomeOptions): string {
  const explicit = options.env.MISTYMOON_DSH_HOME
  if (explicit !== undefined && explicit.trim() !== '') return explicit
  if (options.platform === 'win32') {
    return join(options.env.LOCALAPPDATA ?? join(options.homeDirectory, 'AppData', 'Local'), 'MistyMoon', 'dsh')
  }
  return join(options.env.XDG_DATA_HOME ?? join(options.homeDirectory, '.local', 'share'), 'mistymoon', 'dsh')
}

/** Inputs for installing the repository's current development profile. */
export interface InstallProfileOptions {
  /** MistyMoon-DSH repository root containing the package workspace. */
  workspaceRoot: string
  /** Dedicated DSH home that will own the profile and all private runtime data. */
  dshHome: string
  /** Optional immutable bundle prepared by the caller; omitted production previews build a fresh archive. */
  bundleArchivePath?: string
  /** Optional root containing the compatible DSH runtime; defaults to workspaceRoot. */
  dshRuntimeRoot?: string
}

/** Inputs for building one reusable immutable preview bundle. */
export interface PackProfileBundleOptions {
  workspaceRoot: string
  outputPath: string
}

/** Stable locations and compatibility version produced by installation. */
export interface InstalledProfile {
  dshHome: string
  dshVersion: string
  profileDir: string
}

/** Read-only inputs for the complete Owner-facing MistyMoon installation. */
export interface PreviewMistyMoonInstallationOptions {
  /** Root of the exact source or unpacked published package being installed. */
  packageRoot: string
  /** Root whose node_modules contains the compatible public DSH CLI. */
  dshRuntimeRoot: string
  /** DSH Home that owns both its Profile and user Agent preset directory. */
  dshHome: string
  /** Optional immutable published tgz used instead of packing packageRoot on apply. */
  bundleArchivePath?: string
  /** True only when packageRoot is itself an unpacked published package. */
  packageRootIsPublishedBundle?: boolean
}

/** Immutable, content-free preview for one bundle plus RP Host installation. */
export interface MistyMoonInstallationPlanV1 {
  readonly version: 1
  readonly action: 'install' | 'update'
  readonly status: 'ready' | 'target-exists' | 'profile-conflict'
  readonly requiresOwnerConfirmation: true
  readonly profileName: 'web'
  readonly dshHome: string
  readonly dshVersion: string
  readonly packageVersion: string
  readonly packageRoot: string
  readonly dshRuntimeRoot: string
  readonly bundleArchivePath?: string
  readonly packageRootIsPublishedBundle: boolean
  readonly profileDir: string
  readonly profilePackage: ProfilePackagePreviewV1
  readonly preset: AgentPresetProvisionPlanV1
  readonly workPreset: AgentPresetProvisionPlanV1
  readonly currentState?: MistyMoonInstallStateV1
}

/** Existing Profile package state reviewed as part of the install preview. */
export interface ProfilePackagePreviewV1 {
  readonly status: 'absent'
    | 'stale-source-link'
    | 'declared-source-link'
    | 'declared-bundle-archive'
    | 'conflict'
  readonly requiresRemoval: boolean
  readonly packageDirectory: string
  readonly sourceDirectory?: string
  /** Exact package spec reviewed for restoration if replacement fails. */
  readonly restorationSpec?: string
  /** Exact existing archive protected before a same-path published repack. */
  readonly archivePath?: string
}

/** Locations published by a successful complete MistyMoon installation. */
export interface InstalledMistyMoon extends InstalledProfile {
  presetDir: string
  presetId: typeof RP_HOST_PRESET_ID
  workPresetDir: string
  workPresetId: typeof WORK_PRESET_ID
}

/** Immutable Owner-reviewable rollback from the active version to its retained predecessor. */
export interface MistyMoonRollbackPlanV1 {
  readonly version: 1
  readonly action: 'rollback'
  readonly status: 'ready'
  readonly requiresOwnerConfirmation: true
  readonly dshHome: string
  readonly dshRuntimeRoot: string
  readonly packageRoot: string
  readonly profileDir: string
  readonly profilePackage: ProfilePackagePreviewV1
  readonly currentState: MistyMoonInstallStateV1
  readonly previousBundleArchivePath: string
  readonly previousRpPresetPath: string
  readonly previousWorkPresetPath: string
}

/** Locations selected by a completed rollback; both versioned preset generations remain. */
export interface RolledBackMistyMoon extends InstalledProfile {
  presetDir: string
  presetId: string
  workPresetDir: string
  workPresetId: string
}

interface ProfileManifestShape {
  dependencies?: Record<string, unknown>
}

function commandInvocation(command: string, args: readonly string[]): { executable: string; args: readonly string[] } {
  const packageManager = process.env.npm_execpath
  if (command === 'pnpm' && packageManager !== undefined) {
    return { executable: process.execPath, args: [packageManager, ...args] }
  }
  if (command === 'pnpm' && process.platform === 'win32') {
    const corepackPnpm = join(dirname(process.execPath), 'node_modules', 'corepack', 'dist', 'pnpm.js')
    if (existsSync(corepackPnpm)) {
      return { executable: process.execPath, args: [corepackPnpm, ...args] }
    }
  }
  if (command === 'npm' && process.platform === 'win32') {
    const npmCli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
    if (existsSync(npmCli)) return { executable: process.execPath, args: [npmCli, ...args] }
  }
  return { executable: command === 'pnpm' && process.platform === 'win32' ? 'pnpm.cmd' : command, args }
}

function run(command: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  return new Promise((resolve, reject) => {
    const invocation = commandInvocation(command, args)
    const child = spawn(invocation.executable, invocation.args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk })
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`${command} ${args.join(' ')} failed with exit code ${String(code)}\n${stdout}${stderr}`))
    })
  })
}

function captureNode(args: readonly string[], cwd: string, env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk })
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve(stdout)
      else reject(new Error(`node ${args.join(' ')} failed with exit code ${String(code)}\n${stdout}${stderr}`))
    })
  })
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf8')) as T
}

async function requiredDshVersion(workspaceRoot: string): Promise<string> {
  const manifest: unknown = await readJson<unknown>(join(workspaceRoot, 'package.json'))
  if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) {
    throw new TypeError('MistyMoon package.json must be an object.')
  }
  const devDependencies = (manifest as { devDependencies?: unknown }).devDependencies
  if (typeof devDependencies !== 'object' || devDependencies === null || Array.isArray(devDependencies)) {
    throw new TypeError('MistyMoon package.json must declare devDependencies.')
  }
  const version = (devDependencies as Record<string, unknown>)['@deepseek-ai/dsh']
  if (typeof version !== 'string' || version.trim() === '') {
    throw new TypeError('MistyMoon package.json must declare a non-empty @deepseek-ai/dsh version.')
  }
  return version
}

async function mistyMoonPackageVersion(packageRoot: string): Promise<string> {
  const manifest: unknown = await readJson<unknown>(join(packageRoot, 'package.json'))
  const version = typeof manifest === 'object' && manifest !== null && !Array.isArray(manifest)
    ? (manifest as { version?: unknown }).version
    : undefined
  if (typeof version !== 'string' || !/^[0-9A-Za-z][0-9A-Za-z.+-]*$/.test(version)) {
    throw new TypeError('MistyMoon package.json must contain a safe non-empty version.')
  }
  return version
}

function capture(command: string, args: readonly string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const invocation = commandInvocation(command, args)
    const child = spawn(invocation.executable, invocation.args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdoutText = ''
    let stderrText = ''
    child.stdout.setEncoding('utf8').on('data', chunk => { stdoutText += chunk })
    child.stderr.setEncoding('utf8').on('data', chunk => { stderrText += chunk })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve(stdoutText)
      else reject(new Error(`${command} ${args.join(' ')} failed with exit code ${String(code)}\n${stdoutText}${stderrText}`))
    })
  })
}

async function assertDshRuntime(packageRoot: string, dshRuntimeRoot: string): Promise<string> {
  const expectedVersion = await requiredDshVersion(packageRoot)
  const runtime: unknown = await readJson<unknown>(join(
    dshRuntimeRoot,
    'node_modules',
    '@deepseek-ai',
    'dsh',
    'package.json',
  ))
  if (typeof runtime !== 'object' || runtime === null || Array.isArray(runtime)
    || typeof (runtime as { version?: unknown }).version !== 'string'
    || (runtime as { version: string }).version.trim() === '') {
    throw new TypeError('The external DSH package.json must contain a non-empty string version.')
  }
  const runtimeVersion = (runtime as { version: string }).version
  if (runtimeVersion !== expectedVersion) {
    throw new Error(`MistyMoon requires DSH ${expectedVersion}, found ${runtimeVersion}`)
  }
  return expectedVersion
}

function sameResolvedPath(left: string, right: string): boolean {
  const normalize = (value: string) => process.platform === 'win32'
    ? resolve(value).toLowerCase()
    : resolve(value)
  return normalize(left) === normalize(right)
}

async function inspectProfilePackage(
  profileDir: string,
  packageRoot: string,
  dshHome: string,
): Promise<ProfilePackagePreviewV1> {
  const packageDirectory = join(profileDir, 'node_modules', '@mistymoon', 'dsh')
  const manifestPath = join(profileDir, 'package.json')
  let dependencySpec: string | undefined
  if (existsSync(manifestPath)) {
    const manifest: unknown = await readJson<unknown>(manifestPath)
    if (typeof manifest === 'object' && manifest !== null) {
      const dependencies = (manifest as ProfileManifestShape).dependencies
      const candidate = dependencies?.['@mistymoon/dsh']
      if (typeof candidate === 'string') dependencySpec = candidate
    }
  }

  if (dependencySpec !== undefined) {
    const sourceSpec = dependencySpec.startsWith('link:') ? dependencySpec.slice('link:'.length) : undefined
    if (sourceSpec !== undefined && sameResolvedPath(sourceSpec, packageRoot)) {
      return Object.freeze({
        status: 'declared-source-link',
        requiresRemoval: true,
        packageDirectory,
        sourceDirectory: resolve(sourceSpec),
        restorationSpec: `link:${resolve(sourceSpec)}`,
      })
    }
    const archiveSpec = dependencySpec.startsWith('file:') ? dependencySpec.slice('file:'.length) : undefined
    const reviewedArchiveDirectory = join(resolve(dshHome), 'mistymoon', 'packages')
    if (archiveSpec !== undefined
      && sameResolvedPath(dirname(resolve(archiveSpec)), reviewedArchiveDirectory)
      && BUNDLE_ARCHIVE_NAME.test(basename(resolve(archiveSpec)))
      && existsSync(resolve(archiveSpec))) {
      return Object.freeze({
        status: 'declared-bundle-archive',
        requiresRemoval: true,
        packageDirectory,
        restorationSpec: `file:${resolve(archiveSpec)}`,
        archivePath: resolve(archiveSpec),
      })
    }
    return Object.freeze({ status: 'conflict', requiresRemoval: false, packageDirectory })
  }

  if (!existsSync(packageDirectory)) {
    return Object.freeze({ status: 'absent', requiresRemoval: false, packageDirectory })
  }
  const entry = await lstat(packageDirectory)
  if (entry.isSymbolicLink()) {
    const sourceDirectory = await realpath(packageDirectory)
    if (sameResolvedPath(sourceDirectory, packageRoot)) {
      return Object.freeze({
        status: 'stale-source-link',
        requiresRemoval: true,
        packageDirectory,
        sourceDirectory,
      })
    }
  }
  return Object.freeze({ status: 'conflict', requiresRemoval: false, packageDirectory })
}

/** Build the current workspace once into a caller-owned package archive. */
export async function packProfileBundle(options: PackProfileBundleOptions): Promise<string> {
  await mkdir(dirname(options.outputPath), { recursive: true })
  await rm(options.outputPath, { force: true })
  await run('pnpm', ['pack', '--out', options.outputPath], options.workspaceRoot)
  return options.outputPath
}

interface NpmPackResult {
  filename?: string
}

/** Repack an already-built published package without executing lifecycle scripts. */
export async function packPublishedProfileBundle(packageRoot: string, outputPath: string): Promise<string> {
  const outputDirectory = dirname(outputPath)
  await mkdir(outputDirectory, { recursive: true })
  await rm(outputPath, { force: true })
  const raw = await capture('npm', [
    'pack',
    '--ignore-scripts',
    '--json',
    '--pack-destination',
    outputDirectory,
  ], packageRoot)
  const result: unknown = JSON.parse(raw)
  if (!Array.isArray(result) || result.length !== 1) {
    throw new TypeError('npm pack returned an invalid published bundle result.')
  }
  const entry = result[0] as NpmPackResult
  if (typeof entry.filename !== 'string' || entry.filename === '') {
    throw new TypeError('npm pack did not report its published bundle filename.')
  }
  const generatedPath = join(outputDirectory, entry.filename)
  if (generatedPath !== outputPath) await rename(generatedPath, outputPath)
  return outputPath
}

async function runDshPlugin(
  dshRuntimeRoot: string,
  dshHome: string,
  cwd: string,
  args: readonly string[],
): Promise<void> {
  const dshBin = join(dshRuntimeRoot, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  await run(process.execPath, [dshBin, 'plugin', '--profile', PROFILE_NAME, ...args], cwd, {
    ...process.env,
    DSH_HOME: dshHome,
  })
}

/**
 * Build and install the current bundle through DSH's official profile manager.
 * DSH owns the Web profile manifest; the user's profile patch and all data
 * below the dedicated DSH home are preserved on reinstall.
 * @param options - Repository and target DSH home locations.
 * @returns Installed profile locations and its exact DSH version.
 */
export async function installProfile(options: InstallProfileOptions): Promise<InstalledProfile> {
  const profileDir = join(options.dshHome, 'profiles', PROFILE_NAME)
  const dshVersion = await requiredDshVersion(options.workspaceRoot)
  const packageCache = join(options.dshHome, 'mistymoon', 'packages')
  const bundleArchive = options.bundleArchivePath ?? join(packageCache, 'mistymoon-dsh.tgz')
  await mkdir(packageCache, { recursive: true })
  if (options.bundleArchivePath === undefined) await packProfileBundle({ workspaceRoot: options.workspaceRoot, outputPath: bundleArchive })

  await runDshPlugin(
    options.dshRuntimeRoot ?? options.workspaceRoot,
    options.dshHome,
    options.workspaceRoot,
    [
    'add',
    bundleArchive,
    '--ignore-scripts',
    ],
  )

  return { dshHome: options.dshHome, dshVersion, profileDir }
}

/**
 * Preview the single user-visible installation while keeping DSH Profile and
 * Agent preset ownership explicit in the returned plan.
 */
export async function previewMistyMoonInstallation(
  options: PreviewMistyMoonInstallationOptions,
): Promise<MistyMoonInstallationPlanV1> {
  const dshVersion = await assertDshRuntime(options.packageRoot, options.dshRuntimeRoot)
  const packageVersion = await mistyMoonPackageVersion(options.packageRoot)
  const profileDir = join(options.dshHome, 'profiles', PROFILE_NAME)
  const profilePackage = await inspectProfilePackage(profileDir, options.packageRoot, options.dshHome)
  const preset = await previewAgentPresetProvision({
    version: 1,
    action: 'install',
    dshHome: options.dshHome,
    sourceDirectory: join(
      options.packageRoot,
      'packages',
      'foundation',
      'presets',
      RP_HOST_PRESET_ID,
    ),
    nativePresetId: RP_HOST_PRESET_ID,
  })
  const workPreset = await previewAgentPresetProvision({
    version: 1,
    action: 'install',
    dshHome: options.dshHome,
    sourceDirectory: join(
      options.packageRoot,
      'packages',
      'work-agent',
      'presets',
      WORK_PRESET_ID,
    ),
    nativePresetId: WORK_PRESET_ID,
  })
  return Object.freeze({
    version: 1,
    action: 'install',
    status: preset.status === 'target-exists' || workPreset.status === 'target-exists'
      ? 'target-exists'
      : profilePackage.status === 'conflict' ? 'profile-conflict' : 'ready',
    requiresOwnerConfirmation: true,
    profileName: PROFILE_NAME,
    dshHome: options.dshHome,
    dshVersion,
    packageVersion,
    packageRoot: options.packageRoot,
    dshRuntimeRoot: options.dshRuntimeRoot,
    ...(options.bundleArchivePath === undefined ? {} : { bundleArchivePath: options.bundleArchivePath }),
    packageRootIsPublishedBundle: options.packageRootIsPublishedBundle === true,
    profileDir,
    profilePackage,
    preset,
    workPreset,
  })
}

async function assertCurrentProfileMatchesState(
  profilePackage: ProfilePackagePreviewV1,
  state: MistyMoonInstallStateV1,
): Promise<void> {
  if (profilePackage.status !== 'declared-bundle-archive'
    || profilePackage.archivePath === undefined
    || basename(profilePackage.archivePath) !== state.bundleArchive) {
    throw new WorkPresetProvisionError(
      'profile-conflict',
      'The installed Web Profile package does not match MistyMoon install state.',
    )
  }
  const manifest: unknown = await readJson<unknown>(join(profilePackage.packageDirectory, 'package.json'))
  if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)
    || (manifest as { name?: unknown }).name !== '@mistymoon/dsh'
    || (manifest as { version?: unknown }).version !== state.packageVersion) {
    throw new WorkPresetProvisionError(
      'profile-conflict',
      'The installed MistyMoon package identity does not match install state.',
    )
  }
}

async function discoverLegacyRc5State(
  options: PreviewMistyMoonInstallationOptions,
  profilePackage: ProfilePackagePreviewV1,
  dshVersion: string,
): Promise<MistyMoonInstallStateV1> {
  if (profilePackage.status !== 'declared-bundle-archive'
    || profilePackage.archivePath === undefined) {
    throw new WorkPresetProvisionError(
      'profile-conflict',
      'No tracked installation or supported legacy MistyMoon bundle was found.',
    )
  }
  const manifest: unknown = await readJson<unknown>(join(profilePackage.packageDirectory, 'package.json'))
  if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)
    || (manifest as { name?: unknown }).name !== '@mistymoon/dsh'
    || (manifest as { version?: unknown }).version !== '0.0.1-rc.5') {
    throw new WorkPresetProvisionError(
      'profile-conflict',
      'The untracked MistyMoon installation is not the supported rc.5 compatibility source.',
    )
  }
  const rpPresetId = 'mistymoon-rp-host-v1'
  const workPresetId = 'mistymoon-work-anchored-standard-v1'
  const rpPresetPath = join(options.dshHome, '.agent-presets', rpPresetId)
  const workPresetPath = join(options.dshHome, '.agent-presets', workPresetId)
  const rpPresetFingerprint = await fingerprintAgentPresetDirectory(rpPresetPath)
  const workPresetFingerprint = await fingerprintAgentPresetDirectory(workPresetPath)
  const packagedRpFingerprint = await fingerprintAgentPresetDirectory(join(
    profilePackage.packageDirectory,
    'packages',
    'foundation',
    'presets',
    rpPresetId,
  ))
  const packagedWorkFingerprint = await fingerprintAgentPresetDirectory(join(
    profilePackage.packageDirectory,
    'packages',
    'work-agent',
    'presets',
    workPresetId,
  ))
  if (rpPresetFingerprint !== packagedRpFingerprint || workPresetFingerprint !== packagedWorkFingerprint) {
    throw new WorkPresetProvisionError(
      'source-changed',
      'The untracked rc.5 presets do not match their installed package and cannot be adopted.',
    )
  }
  return Object.freeze({
    version: 1,
    packageName: '@mistymoon/dsh',
    packageVersion: '0.0.1-rc.5',
    bundleArchive: basename(profilePackage.archivePath),
    bundleFingerprint: await fingerprintInstallerArtifact(profilePackage.archivePath),
    dshVersion,
    profileName: PROFILE_NAME,
    rpPresetId,
    rpPresetFingerprint,
    workPresetId,
    workPresetFingerprint,
  })
}

/** Preview a versioned update while retaining the currently active preset assets. */
export async function previewMistyMoonUpdate(
  options: PreviewMistyMoonInstallationOptions,
): Promise<MistyMoonInstallationPlanV1> {
  const dshVersion = await assertDshRuntime(options.packageRoot, options.dshRuntimeRoot)
  const packageVersion = await mistyMoonPackageVersion(options.packageRoot)
  const profileDir = join(options.dshHome, 'profiles', PROFILE_NAME)
  const profilePackage = await inspectProfilePackage(profileDir, options.packageRoot, options.dshHome)
  const trackedState = await readMistyMoonInstallState(options.dshHome)
  let currentState: MistyMoonInstallStateV1
  if (trackedState === undefined) {
    currentState = await discoverLegacyRc5State(options, profilePackage, dshVersion)
  } else {
    const status = await inspectMistyMoonInstallation({ dshHome: options.dshHome })
    if (status.status !== 'installed') {
      throw new WorkPresetProvisionError(
        'source-changed',
        `The tracked MistyMoon installation has drift (${status.issues.join(', ')}).`,
      )
    }
    currentState = trackedState
  }
  await assertCurrentProfileMatchesState(profilePackage, currentState)
  if (currentState.dshVersion !== dshVersion) {
    throw new WorkPresetProvisionError('invalid-input', 'The tracked DSH version differs from the target package requirement.')
  }
  if (currentState.packageVersion === packageVersion) {
    throw new WorkPresetProvisionError('invalid-input', `MistyMoon ${packageVersion} is already installed.`)
  }
  const preset = await previewAgentPresetProvision({
    version: 1,
    action: 'upgrade',
    dshHome: options.dshHome,
    sourceDirectory: join(options.packageRoot, 'packages', 'foundation', 'presets', RP_HOST_PRESET_ID),
    nativePresetId: RP_HOST_PRESET_ID,
    currentNativePresetId: currentState.rpPresetId,
  })
  const workPreset = await previewAgentPresetProvision({
    version: 1,
    action: 'upgrade',
    dshHome: options.dshHome,
    sourceDirectory: join(options.packageRoot, 'packages', 'work-agent', 'presets', WORK_PRESET_ID),
    nativePresetId: WORK_PRESET_ID,
    currentNativePresetId: currentState.workPresetId,
  })
  return Object.freeze({
    version: 1,
    action: 'update',
    status: preset.status === 'target-exists' || workPreset.status === 'target-exists'
      ? 'target-exists'
      : 'ready',
    requiresOwnerConfirmation: true,
    profileName: PROFILE_NAME,
    dshHome: options.dshHome,
    dshVersion,
    packageVersion,
    packageRoot: options.packageRoot,
    dshRuntimeRoot: options.dshRuntimeRoot,
    ...(options.bundleArchivePath === undefined ? {} : { bundleArchivePath: options.bundleArchivePath }),
    packageRootIsPublishedBundle: options.packageRootIsPublishedBundle === true,
    profileDir,
    profilePackage,
    preset,
    workPreset,
    currentState,
  })
}

async function assertRetainedArtifact(
  path: string,
  fingerprint: string,
  kind: 'file' | 'directory',
  label: string,
): Promise<void> {
  if (!existsSync(path)) {
    throw new WorkPresetProvisionError('current-missing', `The retained ${label} required for rollback is missing.`)
  }
  const actual = kind === 'file'
    ? await fingerprintInstallerArtifact(path)
    : await fingerprintAgentPresetDirectory(path)
  if (actual !== fingerprint) {
    throw new WorkPresetProvisionError('source-changed', `The retained ${label} required for rollback has changed.`)
  }
}

/** Preview rollback to the exact bundle and presets retained by the last update. */
export async function previewMistyMoonRollback(
  options: Omit<PreviewMistyMoonInstallationOptions, 'bundleArchivePath' | 'packageRootIsPublishedBundle'>,
): Promise<MistyMoonRollbackPlanV1> {
  const dshVersion = await assertDshRuntime(options.packageRoot, options.dshRuntimeRoot)
  const currentState = await readMistyMoonInstallState(options.dshHome)
  if (currentState === undefined || currentState.previous === undefined) {
    throw new WorkPresetProvisionError('current-missing', 'No tracked previous MistyMoon version is available for rollback.')
  }
  const status = await inspectMistyMoonInstallation({ dshHome: options.dshHome })
  if (status.status !== 'installed') {
    throw new WorkPresetProvisionError(
      'source-changed',
      `The tracked MistyMoon installation has drift (${status.issues.join(', ')}).`,
    )
  }
  if (currentState.dshVersion !== dshVersion) {
    throw new WorkPresetProvisionError('invalid-input', 'The tracked DSH version differs from the rollback runtime.')
  }
  const profileDir = join(options.dshHome, 'profiles', PROFILE_NAME)
  const profilePackage = await inspectProfilePackage(profileDir, options.packageRoot, options.dshHome)
  await assertCurrentProfileMatchesState(profilePackage, currentState)
  const previousBundleArchivePath = join(
    options.dshHome,
    'mistymoon',
    'packages',
    currentState.previous.bundleArchive,
  )
  const previousRpPresetPath = join(options.dshHome, '.agent-presets', currentState.previous.rpPresetId)
  const previousWorkPresetPath = join(options.dshHome, '.agent-presets', currentState.previous.workPresetId)
  await assertRetainedArtifact(
    previousBundleArchivePath,
    currentState.previous.bundleFingerprint,
    'file',
    'bundle archive',
  )
  await assertRetainedArtifact(
    previousRpPresetPath,
    currentState.previous.rpPresetFingerprint,
    'directory',
    'RP Host preset',
  )
  await assertRetainedArtifact(
    previousWorkPresetPath,
    currentState.previous.workPresetFingerprint,
    'directory',
    'Work preset',
  )
  return Object.freeze({
    version: 1,
    action: 'rollback',
    status: 'ready',
    requiresOwnerConfirmation: true,
    dshHome: options.dshHome,
    dshRuntimeRoot: options.dshRuntimeRoot,
    packageRoot: options.packageRoot,
    profileDir,
    profilePackage,
    currentState,
    previousBundleArchivePath,
    previousRpPresetPath,
    previousWorkPresetPath,
  })
}

/** Apply one confirmed rollback and atomically swap current/previous state. */
export async function applyMistyMoonRollback(
  plan: MistyMoonRollbackPlanV1,
  options: { readonly ownerConfirmed: boolean },
): Promise<RolledBackMistyMoon> {
  if (!options.ownerConfirmed) {
    throw new WorkPresetProvisionError('confirmation-required', 'Owner confirmation is required to roll back MistyMoon.')
  }
  const previous = plan.currentState.previous
  if (previous === undefined) {
    throw new WorkPresetProvisionError('current-missing', 'The reviewed rollback has no previous MistyMoon version.')
  }
  const currentArchivePath = join(
    plan.dshHome,
    'mistymoon',
    'packages',
    plan.currentState.bundleArchive,
  )
  const backupPath = join(dirname(currentArchivePath), `.mistymoon-current-${randomUUID()}.tgz`)
  await copyFile(currentArchivePath, backupPath)
  let profileMutationStarted = false
  try {
    profileMutationStarted = true
    await runDshPlugin(plan.dshRuntimeRoot, plan.dshHome, plan.packageRoot, ['remove', '@mistymoon/dsh'])
    await runDshPlugin(plan.dshRuntimeRoot, plan.dshHome, plan.packageRoot, [
      'add',
      `file:${plan.previousBundleArchivePath}`,
      '--ignore-scripts',
    ])
    const installedManifest: unknown = await readJson<unknown>(join(
      plan.profileDir,
      'node_modules',
      '@mistymoon',
      'dsh',
      'package.json',
    ))
    if (typeof installedManifest !== 'object' || installedManifest === null
      || (installedManifest as { name?: unknown }).name !== '@mistymoon/dsh'
      || (installedManifest as { version?: unknown }).version !== previous.packageVersion) {
      throw new WorkPresetProvisionError('profile-conflict', 'The retained rollback bundle has an unexpected package identity.')
    }
    await writeMistyMoonInstallState(plan.dshHome, {
      version: 1,
      packageName: '@mistymoon/dsh',
      packageVersion: previous.packageVersion,
      bundleArchive: previous.bundleArchive,
      bundleFingerprint: previous.bundleFingerprint,
      dshVersion: plan.currentState.dshVersion,
      profileName: PROFILE_NAME,
      rpPresetId: previous.rpPresetId,
      rpPresetFingerprint: previous.rpPresetFingerprint,
      workPresetId: previous.workPresetId,
      workPresetFingerprint: previous.workPresetFingerprint,
      previous: {
        packageVersion: plan.currentState.packageVersion,
        bundleArchive: plan.currentState.bundleArchive,
        bundleFingerprint: plan.currentState.bundleFingerprint,
        rpPresetId: plan.currentState.rpPresetId,
        rpPresetFingerprint: plan.currentState.rpPresetFingerprint,
        workPresetId: plan.currentState.workPresetId,
        workPresetFingerprint: plan.currentState.workPresetFingerprint,
      },
    })
    // State publication is the commit point. A stale temporary backup is safer
    // than reporting failure after the selected bundle and state already agree.
    await rm(backupPath, { force: true }).catch(() => undefined)
    return {
      dshHome: plan.dshHome,
      dshVersion: plan.currentState.dshVersion,
      profileDir: plan.profileDir,
      presetDir: plan.previousRpPresetPath,
      presetId: previous.rpPresetId,
      workPresetDir: plan.previousWorkPresetPath,
      workPresetId: previous.workPresetId,
    }
  } catch (error) {
    const compensationErrors: unknown[] = []
    if (profileMutationStarted) {
      try {
        await runDshPlugin(plan.dshRuntimeRoot, plan.dshHome, plan.packageRoot, ['remove', '@mistymoon/dsh'])
      } catch (compensationError) {
        compensationErrors.push(compensationError)
      }
      try {
        await copyFile(backupPath, currentArchivePath)
        await runDshPlugin(plan.dshRuntimeRoot, plan.dshHome, plan.packageRoot, [
          'add',
          `file:${currentArchivePath}`,
          '--ignore-scripts',
        ])
      } catch (compensationError) {
        compensationErrors.push(compensationError)
      }
    }
    try {
      await rm(backupPath, { force: true })
    } catch (compensationError) {
      compensationErrors.push(compensationError)
    }
    if (compensationErrors.length > 0) {
      throw new AggregateError(
        [error, ...compensationErrors],
        'MistyMoon rollback failed and one or more compensation operations also failed.',
        { cause: error },
      )
    }
    throw error
  }
}

interface PreparedBundleArchive {
  readonly path: string
  readonly name: string
  readonly created: boolean
}

async function prepareVersionedBundleArchive(
  plan: MistyMoonInstallationPlanV1,
): Promise<PreparedBundleArchive> {
  const name = `mistymoon-dsh-${plan.packageVersion}.tgz`
  const packageCache = join(plan.dshHome, 'mistymoon', 'packages')
  const target = join(packageCache, name)
  await mkdir(packageCache, { recursive: true })
  const lockPath = join(packageCache, `.${name}.lock`)
  const lock = await open(lockPath, 'wx')
  try {
    if (plan.bundleArchivePath !== undefined && sameResolvedPath(plan.bundleArchivePath, target)) {
      if (!existsSync(target)) throw new Error('The reviewed MistyMoon bundle archive is missing.')
      return Object.freeze({ path: target, name, created: false })
    }
    if (existsSync(target)) {
      throw new Error(`The versioned MistyMoon bundle archive already exists (${target}).`)
    }
    if (plan.bundleArchivePath !== undefined) {
      await copyFile(plan.bundleArchivePath, target, constants.COPYFILE_EXCL)
    } else if (plan.packageRootIsPublishedBundle) {
      await packPublishedProfileBundle(plan.packageRoot, target)
    } else {
      await packProfileBundle({ workspaceRoot: plan.packageRoot, outputPath: target })
    }
    return Object.freeze({ path: target, name, created: true })
  } finally {
    await lock.close()
    await rm(lockPath, { force: true })
  }
}

async function removeReviewedProfilePackage(plan: MistyMoonInstallationPlanV1): Promise<void> {
  const reviewed = plan.profilePackage
  if (!reviewed.requiresRemoval) return
  const expectedPackageDirectory = join(
    resolve(plan.dshHome),
    'profiles',
    PROFILE_NAME,
    'node_modules',
    '@mistymoon',
    'dsh',
  )
  if (reviewed.status === 'declared-bundle-archive') {
    if (!sameResolvedPath(reviewed.packageDirectory, expectedPackageDirectory)) {
      throw new WorkPresetProvisionError(
        'profile-conflict',
        'The reviewed bundle-archive Profile package paths are invalid.',
      )
    }
    await runDshPlugin(
      plan.dshRuntimeRoot,
      plan.dshHome,
      plan.packageRoot,
      ['remove', '@mistymoon/dsh'],
    )
    return
  }
  if (!sameResolvedPath(reviewed.packageDirectory, expectedPackageDirectory)
    || reviewed.sourceDirectory === undefined
    || !sameResolvedPath(reviewed.sourceDirectory, plan.packageRoot)) {
    throw new WorkPresetProvisionError(
      'profile-conflict',
      'The reviewed stale Profile package paths are invalid.',
    )
  }
  if (reviewed.status === 'declared-source-link') {
    await runDshPlugin(
      plan.dshRuntimeRoot,
      plan.dshHome,
      plan.packageRoot,
      ['remove', '@mistymoon/dsh'],
    )
  }
  if (!existsSync(reviewed.packageDirectory)) return
  const entry = await lstat(reviewed.packageDirectory)
  if (!entry.isSymbolicLink()) {
    throw new WorkPresetProvisionError(
      'profile-conflict',
      'The reviewed stale Profile package changed before installation.',
    )
  }
  const actualSource = await realpath(reviewed.packageDirectory)
  if (!sameResolvedPath(actualSource, reviewed.sourceDirectory)) {
    throw new WorkPresetProvisionError(
      'profile-conflict',
      'The reviewed stale Profile package target changed before installation.',
    )
  }
  await unlink(reviewed.packageDirectory)
}

interface ProfileRollbackSnapshot {
  readonly archiveBackupPath?: string
}

async function prepareProfileRollback(
  plan: MistyMoonInstallationPlanV1,
): Promise<ProfileRollbackSnapshot> {
  const archivePath = plan.profilePackage.archivePath
  if (archivePath === undefined) return Object.freeze({})
  const archiveBackupPath = join(
    dirname(archivePath),
    `.mistymoon-dsh.rollback-${randomUUID()}.tgz`,
  )
  await copyFile(archivePath, archiveBackupPath)
  return Object.freeze({ archiveBackupPath })
}

async function restoreReviewedProfilePackage(
  plan: MistyMoonInstallationPlanV1,
  snapshot: ProfileRollbackSnapshot,
): Promise<void> {
  const reviewed = plan.profilePackage
  if (!reviewed.requiresRemoval) return
  if (reviewed.status === 'stale-source-link') {
    if (reviewed.sourceDirectory === undefined) {
      throw new WorkPresetProvisionError('profile-conflict', 'The reviewed source link cannot be restored.')
    }
    if (existsSync(reviewed.packageDirectory)) {
      const entry = await lstat(reviewed.packageDirectory)
      if (!entry.isSymbolicLink()
        || !sameResolvedPath(await realpath(reviewed.packageDirectory), reviewed.sourceDirectory)) {
        throw new WorkPresetProvisionError(
          'profile-conflict',
          'The failed installation left an unexpected Profile package at the reviewed source-link path.',
        )
      }
      return
    }
    await mkdir(dirname(reviewed.packageDirectory), { recursive: true })
    await symlink(
      reviewed.sourceDirectory,
      reviewed.packageDirectory,
      process.platform === 'win32' ? 'junction' : 'dir',
    )
    return
  }
  if (reviewed.restorationSpec === undefined) {
    throw new WorkPresetProvisionError('profile-conflict', 'The reviewed Profile package has no restoration source.')
  }
  if (reviewed.archivePath !== undefined) {
    if (snapshot.archiveBackupPath === undefined) {
      throw new WorkPresetProvisionError('profile-conflict', 'The reviewed Profile archive backup is missing.')
    }
    await copyFile(snapshot.archiveBackupPath, reviewed.archivePath)
  }
  await runDshPlugin(
    plan.dshRuntimeRoot,
    plan.dshHome,
    plan.packageRoot,
    ['add', reviewed.restorationSpec, '--ignore-scripts'],
  )
}

async function compensateProfileInstallation(
  plan: MistyMoonInstallationPlanV1,
  snapshot: ProfileRollbackSnapshot,
): Promise<void> {
  let cleanupError: unknown
  try {
    await runDshPlugin(
      plan.dshRuntimeRoot,
      plan.dshHome,
      plan.packageRoot,
      ['remove', '@mistymoon/dsh'],
    )
  } catch (error) {
    cleanupError = error
  }
  try {
    await restoreReviewedProfilePackage(plan, snapshot)
  } catch (restoreError) {
    throw new AggregateError(
      cleanupError === undefined ? [restoreError] : [cleanupError, restoreError],
      'Failed to restore the reviewed DSH Profile package after installation failed.',
      { cause: restoreError },
    )
  }
  if (cleanupError !== undefined && !plan.profilePackage.requiresRemoval) {
    throw cleanupError
  }
}

async function disposeProfileRollback(snapshot: ProfileRollbackSnapshot): Promise<void> {
  if (snapshot.archiveBackupPath !== undefined) {
    await rm(snapshot.archiveBackupPath, { force: true })
  }
}

/** Apply one unchanged, Owner-confirmed bundle plus RP Host installation plan. */
export async function applyMistyMoonInstallation(
  plan: MistyMoonInstallationPlanV1,
  options: { readonly ownerConfirmed: boolean },
): Promise<InstalledMistyMoon> {
  if (!options.ownerConfirmed) {
    throw new WorkPresetProvisionError(
      'confirmation-required',
      'Owner confirmation is required to install MistyMoon and its RP Host preset.',
    )
  }
  if (plan.status !== 'ready') {
    if (plan.status === 'profile-conflict') {
      throw new WorkPresetProvisionError(
        'profile-conflict',
        'The existing Web Profile package is not the reviewed MistyMoon source link.',
      )
    }
    throw new WorkPresetProvisionError(
      'target-exists',
      plan.preset.status === 'target-exists'
        ? `The RP Host preset already exists and will not be overwritten (${plan.preset.targetDirectory}).`
        : `The Work preset already exists and will not be overwritten (${plan.workPreset.targetDirectory}).`,
    )
  }

  let presetProvisioned = false
  let workPresetProvisioned = false
  let profileMutationStarted = false
  let preparedBundle: PreparedBundleArchive | undefined
  const rollback = await prepareProfileRollback(plan)
  try {
    await applyAgentPresetProvision(plan.preset, { ownerConfirmed: true })
    presetProvisioned = true
    await applyAgentPresetProvision(plan.workPreset, { ownerConfirmed: true })
    workPresetProvisioned = true
    preparedBundle = await prepareVersionedBundleArchive(plan)
    profileMutationStarted = true
    await removeReviewedProfilePackage(plan)
    const installed = await installProfile({
      workspaceRoot: plan.packageRoot,
      dshHome: plan.dshHome,
      dshRuntimeRoot: plan.dshRuntimeRoot,
      bundleArchivePath: preparedBundle.path,
    })
    await writeMistyMoonInstallState(plan.dshHome, {
      version: 1,
      packageName: '@mistymoon/dsh',
      packageVersion: plan.packageVersion,
      bundleArchive: preparedBundle.name,
      bundleFingerprint: await fingerprintInstallerArtifact(preparedBundle.path),
      dshVersion: plan.dshVersion,
      profileName: PROFILE_NAME,
      rpPresetId: plan.preset.nativePresetId,
      rpPresetFingerprint: plan.preset.sourceFingerprint,
      workPresetId: plan.workPreset.nativePresetId,
      workPresetFingerprint: plan.workPreset.sourceFingerprint,
      ...(plan.currentState === undefined ? {} : {
        previous: {
          packageVersion: plan.currentState.packageVersion,
          bundleArchive: plan.currentState.bundleArchive,
          bundleFingerprint: plan.currentState.bundleFingerprint,
          rpPresetId: plan.currentState.rpPresetId,
          rpPresetFingerprint: plan.currentState.rpPresetFingerprint,
          workPresetId: plan.currentState.workPresetId,
          workPresetFingerprint: plan.currentState.workPresetFingerprint,
        },
      }),
    })
    // State publication commits the operation; cleanup must not trigger a
    // compensating rollback that would leave the new state pointing at old bits.
    await disposeProfileRollback(rollback).catch(() => undefined)
    return {
      ...installed,
      presetDir: plan.preset.targetDirectory,
      presetId: RP_HOST_PRESET_ID,
      workPresetDir: plan.workPreset.targetDirectory,
      workPresetId: WORK_PRESET_ID,
    }
  } catch (error) {
    const compensationErrors: unknown[] = []
    if (profileMutationStarted) {
      try {
        await compensateProfileInstallation(plan, rollback)
      } catch (compensationError) {
        compensationErrors.push(compensationError)
      }
    }
    if (workPresetProvisioned) {
      try {
        await compensateAgentPresetProvision(plan.workPreset)
      } catch (compensationError) {
        compensationErrors.push(compensationError)
      }
    }
    if (presetProvisioned) {
      try {
        await compensateAgentPresetProvision(plan.preset)
      } catch (compensationError) {
        compensationErrors.push(compensationError)
      }
    }
    if (preparedBundle?.created === true) {
      try {
        await rm(preparedBundle.path, { force: true })
      } catch (compensationError) {
        compensationErrors.push(compensationError)
      }
    }
    try {
      await disposeProfileRollback(rollback)
    } catch (compensationError) {
      compensationErrors.push(compensationError)
    }
    if (compensationErrors.length > 0) {
      throw new AggregateError(
        [error, ...compensationErrors],
        'MistyMoon installation failed and one or more rollback operations also failed.',
        { cause: error },
      )
    }
    throw error
  }
}

/**
 * Resolve an installed preview through the exact DSH runtime pinned by its profile.
 * @param options - Repository containing the pinned runtime and target DSH home.
 * @returns DSH's fully composed configuration text.
 */
export async function dumpProfile(options: InstallProfileOptions): Promise<string> {
  const expectedVersion = await requiredDshVersion(options.workspaceRoot)
  const dshPackageRoot = join(options.workspaceRoot, 'node_modules', '@deepseek-ai', 'dsh')
  const runtime = await readJson<{ version: string }>(join(dshPackageRoot, 'package.json'))
  if (runtime.version !== expectedVersion) {
    throw new Error(`MistyMoon requires DSH ${expectedVersion}, found ${runtime.version}`)
  }
  return captureNode(
    [join(dshPackageRoot, 'lib', 'bin.js'), '--profile', PROFILE_NAME, '--dump-config'],
    options.workspaceRoot,
    { ...process.env, DSH_HOME: options.dshHome },
  )
}

/**
 * Activate the installed Web profile through its no-bind help path.
 * @param options - Repository containing the pinned runtime and target DSH home.
 * @returns Web profile help text after plugin activation succeeds.
 */
export async function smokeProfile(options: InstallProfileOptions): Promise<string> {
  const expectedVersion = await requiredDshVersion(options.workspaceRoot)
  const dshPackageRoot = join(options.workspaceRoot, 'node_modules', '@deepseek-ai', 'dsh')
  const runtime = await readJson<{ version: string }>(join(dshPackageRoot, 'package.json'))
  if (runtime.version !== expectedVersion) {
    throw new Error(`MistyMoon requires DSH ${expectedVersion}, found ${runtime.version}`)
  }
  return captureNode(
    [join(dshPackageRoot, 'lib', 'bin.js'), '--profile', PROFILE_NAME, '--help'],
    options.workspaceRoot,
    { ...process.env, DSH_HOME: options.dshHome },
  )
}

/**
 * Run the installed MistyMoon Web profile in the foreground.
 * @param options - Repository containing the pinned runtime and target DSH home.
 * @param args - Web-profile arguments such as `--port 3081`.
 * @returns Child process exit code, or one when the process ended without a code.
 */
export async function startProfile(options: InstallProfileOptions, args: readonly string[] = []): Promise<number> {
  const expectedVersion = await requiredDshVersion(options.workspaceRoot)
  const dshPackageRoot = join(options.workspaceRoot, 'node_modules', '@deepseek-ai', 'dsh')
  const runtime = await readJson<{ version: string }>(join(dshPackageRoot, 'package.json'))
  if (runtime.version !== expectedVersion) {
    throw new Error(`MistyMoon requires DSH ${expectedVersion}, found ${runtime.version}`)
  }
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [join(dshPackageRoot, 'lib', 'bin.js'), '--profile', PROFILE_NAME, ...args],
      {
        cwd: options.workspaceRoot,
        env: { ...process.env, DSH_HOME: options.dshHome },
        stdio: 'inherit',
      },
    )
    child.on('error', reject)
    child.on('close', code => resolve(code ?? 1))
  })
}
