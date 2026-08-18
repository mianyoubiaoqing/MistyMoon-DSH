import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as IdentityPlugin from '@mistymoon/dsh-identity'
import { describe, expect, it } from 'vitest'
import * as Foundation from '../src/index.js'
import { initializePersona } from '../src/index.js'

describe('initializePersona', () => {
  it('creates the private persona once and preserves later owner edits', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mistymoon-persona-'))
    const templatePath = join(root, 'public-template.json')
    const privateHome = join(root, 'private-home')
    await writeFile(templatePath, '{"displayName":"Example"}\n', 'utf8')

    const first = await initializePersona({ privateHome, templatePath })
    expect(first.created).toBe(true)
    expect(first.path).toBe(join(privateHome, 'persona', 'persona.json'))
    expect(await readFile(first.path, 'utf8')).toBe('{"displayName":"Example"}\n')

    await writeFile(first.path, '{"displayName":"Owner edited"}\n', 'utf8')
    const second = await initializePersona({ privateHome, templatePath })

    expect(second).toEqual({ path: first.path, created: false })
    expect(await readFile(first.path, 'utf8')).toBe('{"displayName":"Owner edited"}\n')
  })

  it('publishes only one creation result under concurrent first start', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mistymoon-persona-race-'))
    const templatePath = join(root, 'public-template.json')
    const privateHome = join(root, 'private-home')
    await writeFile(templatePath, '{"displayName":"Example"}\n', 'utf8')

    const results = await Promise.all([
      initializePersona({ privateHome, templatePath }),
      initializePersona({ privateHome, templatePath }),
    ])

    expect(results.map(result => result.created).sort()).toEqual([false, true])
  })

  it('loads as a Cordis plugin and initializes the bundled neutral template', async () => {
    const privateHome = await mkdtemp(join(tmpdir(), 'mistymoon-plugin-'))
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(IdentityPlugin, { ownerId: 'owner-fixture' })

    const fiber = await ctx.plugin(Foundation, { home: privateHome })

    const persona = JSON.parse(await readFile(join(privateHome, 'persona', 'persona.json'), 'utf8')) as {
      kind?: string
      displayName?: string
    }
    expect(persona).toMatchObject({ kind: 'mistymoon.persona', displayName: 'Misty' })
    await fiber.dispose()
  })
})
