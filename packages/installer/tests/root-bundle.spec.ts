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
      bin?: Record<string, string>
      files?: string[]
      exports?: Record<string, unknown>
      dsh?: { bundle?: { patch?: string }; client?: { platform?: string } }
    }
    const patch = yaml.load(await readFile(`${workspaceRoot}/cordis.patch.yml`, 'utf8'), {
      schema: dshSchema,
    }) as Array<{ insert?: Array<{ id?: string; name?: string; config?: Record<string, unknown> }> }>

    expect(manifest.name).toBe('@mistymoon/dsh')
    expect(manifest.private).toBe(true)
    expect(manifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
    expect(manifest.dsh?.client?.platform).toBe('web')
    expect(manifest.files).toContain('packages/work-agent/presets')
    expect(manifest.files).toContain('packages/installer/lib')
    expect(manifest.bin).toEqual({
      'mistymoon-dsh-install': './packages/installer/lib/cli.js',
    })
    expect(Object.keys(manifest.exports ?? {})).toEqual([
      '.',
      './client',
      './foundation',
      './foundation/rp-host',
      './identity',
      './memory',
      './memory/domain',
      './memory/candidate-extraction',
      './memory/conflict',
      './memory/retrieval',
      './memory/advanced-retrieval',
      './memory/lifecycle',
      './memory/legacy-migration',
      './memory/maintenance',
      './installer',
      './work-agent',
      './work-agent-dsh',
      './package.json',
    ])
    expect(patch[0]?.insert?.map(row => row.name)).toEqual([
      '@mistymoon/dsh/identity',
      '@mistymoon/dsh/foundation',
      '@mistymoon/dsh',
      '@mistymoon/dsh/memory',
      '@mistymoon/dsh/work-agent-dsh',
    ])
    expect(patch[0]?.insert?.at(-1)).toMatchObject({
      id: 'mistymoon-work-agent-runtime',
      config: {
        settingsPath: "dshHomePath('mistymoon', 'settings', 'work-model.json')",
      },
    })
  })

  it('publishes the versioned Work preset source with its package contract', async () => {
    const manifest = JSON.parse(await readFile(
      `${workspaceRoot}/packages/work-agent/package.json`,
      'utf8',
    )) as { files?: string[] }

    expect(manifest.files).toEqual(['lib', 'presets'])
    await expect(readFile(
      `${workspaceRoot}/packages/work-agent/presets/mistymoon-work-anchored-standard-v2/agent.cordis.yml`,
      'utf8',
    )).resolves.toContain('MISTYMOON PATCH')
  })

  it('publishes an rc.7-compatible RP Host preset with only read-only Web and fixed foreground Work tools', async () => {
    const manifest = JSON.parse(await readFile(
      `${workspaceRoot}/packages/foundation/package.json`,
      'utf8',
    )) as { files?: string[]; exports?: Record<string, unknown> }
    const preset = yaml.load(await readFile(
      `${workspaceRoot}/packages/foundation/presets/mistymoon-rp-host-v2/agent.cordis.yml`,
      'utf8',
    )) as Array<{
      id?: string
      name?: string
      config?: Record<string, unknown> | Array<{ id?: string; config?: Record<string, unknown> }>
    }>

    expect(manifest.files).toContain('presets')
    expect(manifest.exports).toHaveProperty('./rp-host')
    expect(preset.map(row => row.name)).toEqual([
      '@deepseek-ai/dsh-tool-web',
      '@deepseek-ai/dsh-tool-fs',
      '@deepseek-ai/dsh-tool-fs-search',
      '@deepseek-ai/dsh-tool-subagent',
      '@deepseek-ai/dsh-tool-ask-user',
      '@mistymoon/dsh/foundation/rp-host',
      'cordis:group',
    ])
    expect(preset[0]?.config).toMatchObject({ search: true, fetch: true })
    expect(preset[3]).toMatchObject({
      id: 'mistymoon-code-flash',
      config: {
        provider: 'mistymoon-work-flash',
        toolName: 'mistymoon_code_flash',
        enableRunInBackground: false,
        backgroundMode: 'one-shot',
        maxDepth: 'provider-managed',
      },
    })
    expect(JSON.stringify(preset)).not.toMatch(/mistymoon-work-pro|mistymoon_code_pro|mistymoon_prepare_final_reply|shell|write|patch|git|browser/i)
  })

  it('declares the official tools and system-prompt capabilities the two-phase delivery coordinator consumes', async () => {
    const manifest = JSON.parse(await readFile(`${workspaceRoot}/packages/foundation/package.json`, 'utf8')) as {
      peerDependencies?: Record<string, string>
    }

    expect(manifest.peerDependencies?.['@deepseek-ai/dsh-tools'])
      .toBe('>=0.1.0-rc.7 <0.1.0')
    expect(manifest.peerDependencies?.['@deepseek-ai/dsh-system-prompt'])
      .toBe('>=0.1.0-rc.7 <0.1.0')
  })
})
