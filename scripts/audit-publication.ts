import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { auditPublication } from '../packages/foundation/src/index.js'

const root = fileURLToPath(new URL('..', import.meta.url))
const gitOutput = execFileSync(
  'git',
  ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
  { cwd: root, encoding: 'utf8' },
)
const gitFiles = gitOutput.split('\0').filter(Boolean)
const packOutput = process.platform === 'win32'
  ? execFileSync(
      process.env.ComSpec ?? 'cmd.exe',
      ['/d', '/s', '/c', 'npm pack --dry-run --json --ignore-scripts'],
      { cwd: root, encoding: 'utf8' },
    )
  : execFileSync(
      'npm',
      ['pack', '--dry-run', '--json', '--ignore-scripts'],
      { cwd: root, encoding: 'utf8' },
    )
const packManifest: unknown = JSON.parse(packOutput)
if (!Array.isArray(packManifest)) throw new TypeError('npm pack did not return an array manifest.')
const packFiles: string[] = []
for (const entry of packManifest) {
  if (typeof entry !== 'object' || entry === null || !('files' in entry) || !Array.isArray(entry.files)) {
    throw new TypeError('npm pack returned an invalid package entry.')
  }
  for (const file of entry.files) {
    if (typeof file !== 'object' || file === null || !('path' in file) || typeof file.path !== 'string') {
      throw new TypeError('npm pack returned an invalid file entry.')
    }
    packFiles.push(file.path)
  }
}
const files = [...new Set([...gitFiles, ...packFiles])]
const issues = await auditPublication({ root, files })

if (issues.length > 0) {
  for (const issue of issues) process.stderr.write(`${issue.code}: ${issue.path}: ${issue.message}\n`)
  process.exitCode = 1
} else {
  process.stdout.write(`Publication audit passed (${files.length} files).\n`)
}
