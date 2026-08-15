import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { auditPublication } from '../packages/foundation/src/index.js'

const root = fileURLToPath(new URL('..', import.meta.url))
const output = execFileSync(
  'git',
  ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
  { cwd: root, encoding: 'utf8' },
)
const files = output.split('\0').filter(Boolean)
const issues = await auditPublication({ root, files })

if (issues.length > 0) {
  for (const issue of issues) process.stderr.write(`${issue.code}: ${issue.path}: ${issue.message}\n`)
  process.exitCode = 1
} else {
  process.stdout.write(`Publication audit passed (${files.length} files).\n`)
}
