import {
  applyMemoryArchiveMaintenance,
  inspectMemoryArchive,
  planMemoryArchiveMaintenance,
  rehearseMemoryArchiveRollback,
} from '../packages/memory/src/maintenance.js'

function usage(): never {
  throw new Error(
    'usage: pnpm memory:maintenance -- inspect <archive> | '
    + 'plan-migrate <archive> [backup] | plan-recover <archive> [backup] | '
    + 'apply <archive> <token> <expected-digest> | '
    + 'rehearse-rollback <archive> <backup> <expected-backup-digest>',
  )
}

const [command, archivePath, ...rest] = process.argv.slice(2)
if (command === undefined || archivePath === undefined) usage()

let result: unknown
if (command === 'inspect') {
  if (rest.length !== 0) usage()
  result = await inspectMemoryArchive({ path: archivePath })
} else if (command === 'plan-migrate' || command === 'plan-recover') {
  if (rest.length > 1) usage()
  result = await planMemoryArchiveMaintenance({
    path: archivePath,
    action: command === 'plan-migrate' ? 'migrate-v1' : 'recover-trailing',
    backupPath: rest[0],
  })
} else if (command === 'apply') {
  if (rest.length !== 2) usage()
  result = await applyMemoryArchiveMaintenance({
    path: archivePath,
    token: rest[0]!,
    expectedDigest: rest[1]!,
  })
} else if (command === 'rehearse-rollback') {
  if (rest.length !== 2) usage()
  result = await rehearseMemoryArchiveRollback({
    path: archivePath,
    backupPath: rest[0]!,
    expectedBackupDigest: rest[1]!,
  })
} else {
  usage()
}

process.stdout.write(`${JSON.stringify(result, undefined, 2)}\n`)
