import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import {
  dumpProfile,
  installProfile,
  resolvePreviewHome,
  smokeProfile,
  startProfile,
} from '../packages/installer/src/index.js'

const workspaceRoot = fileURLToPath(new URL('..', import.meta.url))
const dshHome = resolvePreviewHome({ env: process.env, platform: process.platform, homeDirectory: homedir() })
const command = process.argv[2]
const args = process.argv.slice(3)

if (!['dump', 'install', 'smoke', 'start'].includes(command ?? '')) {
  process.stderr.write('Usage: pnpm preview:<install|dump|smoke|start> [-- <DSH web arguments>]\n')
  process.exitCode = 2
} else {
  const installed = await installProfile({ workspaceRoot, dshHome })
  if (command === 'install') {
    process.stdout.write(`Installed MistyMoon profile at ${installed.profileDir}\n`)
  } else if (command === 'dump') {
    process.stdout.write(await dumpProfile({ workspaceRoot, dshHome }))
  } else if (command === 'smoke') {
    process.stdout.write(await smokeProfile({ workspaceRoot, dshHome }))
  } else {
    process.exitCode = await startProfile({ workspaceRoot, dshHome }, args)
  }
}
