/**
 * Development preview installation for the MistyMoon DSH profile.
 * @module @mistymoon/dsh-installer
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export * from './work-preset-provisioner.js'

const PROFILE_NAME = 'web'

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
}

/** Stable locations and compatibility version produced by installation. */
export interface InstalledProfile {
  dshHome: string
  dshVersion: string
  profileDir: string
}

interface WorkspaceManifest {
  devDependencies: { '@deepseek-ai/dsh': string }
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
  return (await readJson<WorkspaceManifest>(join(workspaceRoot, 'package.json'))).devDependencies['@deepseek-ai/dsh']
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
  const bundleArchive = join(packageCache, 'mistymoon-dsh.tgz')
  await mkdir(packageCache, { recursive: true })
  await rm(bundleArchive, { force: true })

  await run('pnpm', ['pack', '--out', bundleArchive], options.workspaceRoot)

  const dshPackageRoot = join(options.workspaceRoot, 'node_modules', '@deepseek-ai', 'dsh')
  const dshBin = join(dshPackageRoot, 'lib', 'bin.js')
  const dshEnv = { ...process.env, DSH_HOME: options.dshHome }
  await run(process.execPath, [
    dshBin,
    'plugin',
    '--profile',
    PROFILE_NAME,
    'add',
    bundleArchive,
    '--ignore-scripts',
  ], options.workspaceRoot, dshEnv)

  return { dshHome: options.dshHome, dshVersion, profileDir }
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
