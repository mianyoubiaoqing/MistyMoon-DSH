import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'

const workspaceRoot = fileURLToPath(new URL('../../..', import.meta.url))
const dshJsExpression = new yaml.Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  construct: value => value,
})
const dshSchema = yaml.DEFAULT_SCHEMA.extend([dshJsExpression])

describe('the installable MistyMoon repository bundle', () => {
  it('exposes the Host/client settings plugin and companion plugins from one DSH bundle package', async () => {
    const manifest = JSON.parse(await readFile(`${workspaceRoot}/package.json`, 'utf8')) as {
      name?: string
      private?: boolean
      exports?: Record<string, unknown>
      dsh?: { bundle?: { patch?: string }; client?: { platform?: string } }
    }
    const patch = yaml.load(await readFile(`${workspaceRoot}/cordis.patch.yml`, 'utf8'), {
      schema: dshSchema,
    }) as Array<{ insert?: Array<{ id?: string; name?: string }> }>

    expect(manifest.name).toBe('@mistymoon/dsh')
    expect(manifest.private).not.toBe(true)
    expect(manifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
    expect(manifest.dsh?.client?.platform).toBe('web')
    expect(Object.keys(manifest.exports ?? {})).toEqual([
      '.',
      './client',
      './foundation',
      './memory',
      './memory/legacy-migration',
      './package.json',
    ])
    expect(patch[0]?.insert?.map(row => row.name)).toEqual([
      '@mistymoon/dsh/foundation',
      '@mistymoon/dsh',
      '@mistymoon/dsh/memory',
    ])
  })

  it('declares the official tools and system-prompt capabilities the two-phase delivery coordinator consumes', async () => {
    const manifest = JSON.parse(await readFile(`${workspaceRoot}/packages/foundation/package.json`, 'utf8')) as {
      peerDependencies?: Record<string, string>
    }

    expect(manifest.peerDependencies?.['@deepseek-ai/dsh-tools'])
      .toBe('>=0.1.0-rc.5 <0.1.0')
    expect(manifest.peerDependencies?.['@deepseek-ai/dsh-system-prompt'])
      .toBe('>=0.1.0-rc.5 <0.1.0')
  })
})
