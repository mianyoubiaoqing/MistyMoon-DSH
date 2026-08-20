import { homedir } from 'node:os'
import { createInterface } from 'node:readline/promises'
import { stdin, stdout } from 'node:process'
import { fileURLToPath } from 'node:url'
import {
  applyMistyMoonInstallation,
  dumpProfile,
  previewMistyMoonInstallation,
  resolvePreviewHome,
  smokeProfile,
  startProfile,
} from '../packages/installer/src/index.js'
import { formatInstallationPreview } from '../packages/installer/src/cli.js'

const workspaceRoot = fileURLToPath(new URL('..', import.meta.url))
const dshHome = resolvePreviewHome({ env: process.env, platform: process.platform, homeDirectory: homedir() })
const command = process.argv[2]
const args = process.argv.slice(3)

if (!['dump', 'install', 'smoke', 'start'].includes(command ?? '')) {
  process.stderr.write('Usage: pnpm preview:<install|dump|smoke|start> [-- <DSH web arguments>]\n')
  process.exitCode = 2
} else {
  if (command === 'install') {
    const plan = await previewMistyMoonInstallation({
      packageRoot: workspaceRoot,
      dshRuntimeRoot: workspaceRoot,
      dshHome,
    })
    process.stdout.write(`${formatInstallationPreview({
      profileName: plan.profileName,
      profilePackageStatus: plan.profilePackage.status,
      presetId: plan.preset.nativePresetId,
      presetStatus: plan.preset.status,
      sourceFingerprint: plan.preset.sourceFingerprint,
      workPresetId: plan.workPreset.nativePresetId,
      workPresetStatus: plan.workPreset.status,
      workSourceFingerprint: plan.workPreset.sourceFingerprint,
    })}\n`)
    let ownerConfirmed = args.includes('--yes')
    if (!ownerConfirmed) {
      const prompt = createInterface({ input: stdin, output: stdout })
      try {
        ownerConfirmed = (await prompt.question(
          'Install this development bundle and preset? Type yes to continue: ',
        )).trim() === 'yes'
      } finally {
        prompt.close()
      }
    }
    if (!ownerConfirmed) {
      process.stdout.write('Installation cancelled; no Profile or preset changes were made.\n')
    } else {
      const installed = await applyMistyMoonInstallation(plan, { ownerConfirmed: true })
      process.stdout.write(`Installed MistyMoon profile at ${installed.profileDir}\n`)
      process.stdout.write(`Installed RP Host preset at ${installed.presetDir}\n`)
      process.stdout.write(`Installed Work preset at ${installed.workPresetDir}\n`)
    }
  } else if (command === 'dump') {
    process.stdout.write(await dumpProfile({ workspaceRoot, dshHome }))
  } else if (command === 'smoke') {
    process.stdout.write(await smokeProfile({ workspaceRoot, dshHome }))
  } else {
    process.exitCode = await startProfile({ workspaceRoot, dshHome }, args)
  }
}
