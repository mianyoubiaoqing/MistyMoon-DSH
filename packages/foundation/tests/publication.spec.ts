import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { auditPublication } from '../src/index.js'

async function stage(root: string, path: string, content = 'safe\n'): Promise<void> {
  const absolute = join(root, path)
  await mkdir(join(absolute, '..'), { recursive: true })
  await writeFile(absolute, content, 'utf8')
}

describe('auditPublication', () => {
  it('allows only the public persona template and example assets', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mistymoon-public-safe-'))
    const files = [
      'README.md',
      'personas/template/persona.json',
      'personas/example/persona.json',
      '.env.example',
    ]
    await Promise.all(files.map(path => stage(root, path)))

    await expect(auditPublication({ root, files })).resolves.toEqual([])
  })

  it('rejects private personas, durable state, logs, and credentials', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mistymoon-public-private-'))
    const files = [
      'personas/current/persona.json',
      'state/memory.sqlite3',
      'sessions/private.jsonl',
      '.env',
      'config/provider.yml',
    ]
    await Promise.all([
      stage(root, files[0]!),
      stage(root, files[1]!),
      stage(root, files[2]!),
      stage(root, files[3]!, 'OPENAI_API_KEY=sk-live-secret\n'),
      stage(root, files[4]!, 'apiKey: sk-live-secret\n'),
    ])

    const issues = await auditPublication({ root, files })

    expect(issues.map(issue => issue.code)).toEqual([
      'private-persona',
      'durable-state',
      'session-log',
      'environment-file',
      'credential-content',
    ])
  })

  it('rejects machine-specific local paths without rejecting neutral fixtures', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mistymoon-public-local-path-'))
    const localWorkspace = ['D:', 'ai', 'MistyMoon-DSH'].join('\\')
    const localHome = ['', 'Users', 'actual-owner', 'project'].join('/')
    const files = ['docs/windows.md', 'docs/macos.md', 'dist/client.js.map', 'tests/fixture.md']
    await Promise.all([
      stage(root, files[0]!, `workspace: ${localWorkspace}\n`),
      stage(root, files[1]!, `workspace: ${localHome}\n`),
      stage(root, files[2]!, JSON.stringify({ sources: [localWorkspace] })),
      stage(root, files[3]!, 'fixtures: C:\\Users\\Owner and C:\\Program Files\\nodejs\\node.exe\n'),
    ])

    const issues = await auditPublication({ root, files })

    expect(issues.map(issue => [issue.code, issue.path])).toEqual([
      ['local-path-content', 'docs/windows.md'],
      ['local-path-content', 'docs/macos.md'],
      ['local-path-content', 'dist/client.js.map'],
    ])
  })
})
