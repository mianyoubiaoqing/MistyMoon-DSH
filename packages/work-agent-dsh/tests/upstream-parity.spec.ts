import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)

async function packageArtifact(name: string): Promise<{ manifest: { version?: string }; source: string; license: string }> {
  const manifestPath = require.resolve(`${name}/package.json`)
  const root = dirname(manifestPath)
  return {
    manifest: JSON.parse(await readFile(manifestPath, 'utf8')) as { version?: string },
    source: await readFile(join(root, 'lib', 'index.js'), 'utf8'),
    license: await readFile(join(root, 'LICENSE'), 'utf8'),
  }
}

function sha256(source: string): string {
  return createHash('sha256').update(source).digest('hex')
}

describe('pinned DSH one-shot source parity', () => {
  it('fails loudly when the audited rc.7 driver or child policy artifact changes', async () => {
    const driver = await packageArtifact('@deepseek-ai/dsh-subagent-in-process-driver')
    const child = await packageArtifact('@deepseek-ai/dsh-subagent')

    expect(driver.manifest.version).toBe('0.1.0-rc.7')
    expect(child.manifest.version).toBe('0.1.0-rc.7')
    expect(sha256(driver.source)).toBe('1d1507c653de737bf9a51a19834dacb59bf42c2175bcccd443f42901885ff34b')
    expect(sha256(child.source)).toBe('510aba14f13d1a9deccf3d81d790be3e7ebcdc4797fcfa584908350d07c529c6')
    expect(driver.license).toContain('Copyright (c) 2026 DeepSeek')
    expect(child.license).toContain('Copyright (c) 2026 DeepSeek')
  })
})
