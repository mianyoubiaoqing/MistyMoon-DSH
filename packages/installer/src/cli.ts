#!/usr/bin/env node

import { createInterface } from 'node:readline/promises'
import { stdin, stdout } from 'node:process'
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import {
  applyMistyMoonInstallation,
  applyMistyMoonRollback,
  inspectMistyMoonInstallation,
  previewMistyMoonInstallation,
  previewMistyMoonRollback,
  previewMistyMoonUpdate,
} from './index.js'

export type InstallerCommand = 'install' | 'update' | 'status' | 'rollback'

/** Validated arguments accepted by the published installer executable. */
export interface InstallerArguments {
  command: InstallerCommand
  dshHome: string
  dshRuntimeRoot: string
  ownerConfirmed: boolean
}

/** Content-free values printed before the Owner is asked to confirm. */
export interface InstallationPreviewSummary {
  profileName: string
  profilePackageStatus: 'absent'
    | 'stale-source-link'
    | 'declared-source-link'
    | 'declared-bundle-archive'
    | 'conflict'
  presetId: string
  presetStatus: 'ready' | 'target-exists'
  sourceFingerprint: string
  workPresetId: string
  workPresetStatus: 'ready' | 'target-exists'
  workSourceFingerprint: string
}

/** Parse the small, explicit published installer command boundary. */
export function parseInstallerArguments(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
): InstallerArguments {
  let command: InstallerCommand = 'install'
  let argumentOffset = 0
  const requestedCommand = argv[0]
  if (requestedCommand !== undefined && !requestedCommand.startsWith('-')) {
    if (requestedCommand !== 'install' && requestedCommand !== 'update'
      && requestedCommand !== 'status' && requestedCommand !== 'rollback') {
      throw new TypeError(`Unknown installer command: ${requestedCommand}`)
    }
    command = requestedCommand
    argumentOffset = 1
  }
  let dshHome = env.DSH_HOME
  let dshRuntimeRoot = process.cwd()
  let ownerConfirmed = false
  for (let index = argumentOffset; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--yes') {
      ownerConfirmed = true
      continue
    }
    if (argument !== '--dsh-home' && argument !== '--dsh-root') {
      throw new TypeError(`Unknown installer argument: ${argument ?? ''}`)
    }
    const value = argv[index + 1]
    if (value === undefined || value.trim() === '') {
      throw new TypeError(`${argument} requires a non-empty path.`)
    }
    if (argument === '--dsh-home') dshHome = value
    else dshRuntimeRoot = value
    index += 1
  }
  if (dshHome === undefined || dshHome.trim() === '') {
    throw new TypeError('An explicit DSH Home is required through --dsh-home or DSH_HOME.')
  }
  return { command, dshHome, dshRuntimeRoot, ownerConfirmed }
}

/** Render exactly the Profile and preset writes covered by confirmation. */
export function formatInstallationPreview(summary: InstallationPreviewSummary): string {
  const presetAction = summary.presetStatus === 'ready' ? 'create' : 'refuse existing target'
  const workPresetAction = summary.workPresetStatus === 'ready' ? 'create' : 'refuse existing target'
  const removalActions: Record<InstallationPreviewSummary['profilePackageStatus'], string> = {
    absent: 'none',
    'stale-source-link': 'remove reviewed source link',
    'declared-source-link': 'remove reviewed source link',
    'declared-bundle-archive': 'replace reviewed bundle archive',
    conflict: 'refuse unreviewed existing package',
  }
  return [
    `DSH Profile: ${summary.profileName}`,
    `Existing Profile package: ${removalActions[summary.profilePackageStatus]}`,
    `Agent preset: ${presetAction} ${summary.presetId}`,
    `Preset source fingerprint: ${summary.sourceFingerprint}`,
    `Work preset: ${workPresetAction} ${summary.workPresetId}`,
    `Work preset source fingerprint: ${summary.workSourceFingerprint}`,
  ].join('\n')
}

async function askForConfirmation(action: 'install' | 'update' | 'rollback'): Promise<boolean> {
  const prompt = createInterface({ input: stdin, output: stdout })
  try {
    return (await prompt.question(`${action[0]?.toUpperCase()}${action.slice(1)} this bundle and preset selection? Type yes to continue: `)).trim() === 'yes'
  } finally {
    prompt.close()
  }
}

/** Run the published executable using the exact unpacked package as its source. */
export async function runInstallerCli(
  argv: readonly string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const args = parseInstallerArguments(argv, env)
  const packageRoot = fileURLToPath(new URL('../../../', import.meta.url))
  if (args.command === 'status') {
    const status = await inspectMistyMoonInstallation({ dshHome: args.dshHome })
    stdout.write([
      `Status: ${status.status}`,
      `State: ${status.statePath}`,
      ...(status.packageVersion === undefined ? [] : [`Package version: ${status.packageVersion}`]),
      ...(status.bundleArchivePath === undefined ? [] : [`Bundle archive: ${status.bundleArchivePath}`]),
      ...(status.profilePackagePath === undefined ? [] : [`Profile package: ${status.profilePackagePath}`]),
      ...(status.rpPresetId === undefined ? [] : [
        `RP Host preset: ${status.rpPresetId}`,
        `RP Host fingerprint: ${status.rpPresetFingerprint ?? ''}`,
        `RP Host path: ${status.rpPresetPath ?? ''}`,
      ]),
      ...(status.workPresetId === undefined ? [] : [
        `Work preset: ${status.workPresetId}`,
        `Work preset fingerprint: ${status.workPresetFingerprint ?? ''}`,
        `Work preset path: ${status.workPresetPath ?? ''}`,
      ]),
      `Issues: ${status.issues.length === 0 ? 'none' : status.issues.join(', ')}`,
    ].join('\n') + '\n')
    if (status.status !== 'installed') process.exitCode = 1
    return
  }
  const common = {
    packageRoot,
    dshRuntimeRoot: args.dshRuntimeRoot,
    dshHome: args.dshHome,
  }
  if (args.command === 'rollback') {
    const plan = await previewMistyMoonRollback(common)
    const previous = plan.currentState.previous
    if (previous === undefined) throw new Error('The reviewed rollback has no previous version.')
    stdout.write([
      `Operation: rollback ${plan.currentState.packageVersion} -> ${previous.packageVersion}`,
      `DSH Profile: web`,
      `Bundle archive: ${plan.previousBundleArchivePath}`,
      `RP Host preset: select retained ${previous.rpPresetId}`,
      `RP Host fingerprint: ${previous.rpPresetFingerprint}`,
      `Work preset: select retained ${previous.workPresetId}`,
      `Work preset fingerprint: ${previous.workPresetFingerprint}`,
    ].join('\n') + '\n')
    const ownerConfirmed = args.ownerConfirmed || await askForConfirmation('rollback')
    if (!ownerConfirmed) {
      stdout.write('Rollback cancelled; no Profile, preset, or state changes were made.\n')
      return
    }
    const installed = await applyMistyMoonRollback(plan, { ownerConfirmed })
    stdout.write(`Rolled back MistyMoon Profile at ${installed.profileDir}\n`)
    stdout.write(`Selected retained RP Host preset at ${installed.presetDir}\n`)
    stdout.write(`Selected retained Work preset at ${installed.workPresetDir}\n`)
    return
  }
  const plan = args.command === 'update'
    ? await previewMistyMoonUpdate({ ...common, packageRootIsPublishedBundle: true })
    : await previewMistyMoonInstallation({ ...common, packageRootIsPublishedBundle: true })
  if (plan.status !== 'ready') {
    const reason = plan.status === 'target-exists'
      ? plan.preset.status === 'target-exists'
        ? 'The RP Host preset already exists and will not be overwritten.'
        : 'The Work preset already exists and will not be overwritten.'
      : 'The existing Web Profile package conflicts with the reviewed MistyMoon source.'
    process.stderr.write(`${reason} No Profile or preset changes were made.\n`)
    process.exitCode = 1
    return
  }
  stdout.write(`${formatInstallationPreview({
    profileName: plan.profileName,
    profilePackageStatus: plan.profilePackage.status,
    presetId: plan.preset.nativePresetId,
    presetStatus: plan.preset.status,
    sourceFingerprint: plan.preset.sourceFingerprint,
    workPresetId: plan.workPreset.nativePresetId,
    workPresetStatus: plan.workPreset.status,
    workSourceFingerprint: plan.workPreset.sourceFingerprint,
  })}\n`)
  if (plan.currentState !== undefined) {
    stdout.write(`Operation: update ${plan.currentState.packageVersion} -> ${plan.packageVersion}\n`)
  }
  const ownerConfirmed = args.ownerConfirmed || await askForConfirmation(args.command)
  if (!ownerConfirmed) {
    stdout.write(`${args.command === 'update' ? 'Update' : 'Installation'} cancelled; no Profile, preset, or state changes were made.\n`)
    return
  }
  const installed = await applyMistyMoonInstallation(plan, { ownerConfirmed })
  const completed = args.command === 'update' ? 'Updated' : 'Installed'
  stdout.write(`${completed} MistyMoon Profile at ${installed.profileDir}\n`)
  stdout.write(`${completed} RP Host preset at ${installed.presetDir}\n`)
  stdout.write(`${completed} Work preset at ${installed.workPresetDir}\n`)
}

const invokedPath = process.argv[1]
if (invokedPath !== undefined
  && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(invokedPath)) {
  runInstallerCli().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : 'MistyMoon installation failed.'}\n`)
    process.exitCode = 1
  })
}
