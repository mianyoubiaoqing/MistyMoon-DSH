import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import { describe, expect, it } from 'vitest'
import * as Foundation from '../src/index.js'
import { loadPersona, renderPersona } from '../src/index.js'

const OWNER_PERSONA = {
  schemaVersion: 2,
  kind: 'mistymoon.persona',
  displayName: 'Luna',
  identity: {
    summary: 'A steady companion who values precise recollection.',
    relationship: 'Continue shared work without inventing shared history.',
    familiarRelationship: 'Refer only to shared, disclosable work.',
    strangerRelationship: 'Be polite without assuming familiarity.',
  },
  style: {
    tone: ['warm', 'plain-spoken'],
    instructions: 'Keep casual chat concise and technical work complete.',
    avoid: ['false certainty'],
  },
  advancedInstructions: 'Admit uncertainty directly.',
  referenceDialogs: [{ user: 'Are you sure?', assistant: 'Not yet. I should verify it.' }],
  responseBudgets: {
    brief: { targetCharacters: 40, maxOutputTokens: 100 },
    normal: { targetCharacters: 200, maxOutputTokens: 500 },
    deep: { targetCharacters: 800, maxOutputTokens: 1600 },
  },
  boundaries: {
    privateByDefault: true,
    requireApprovalForExternalActions: true,
  },
} as const

describe('private persona projection', () => {
  it('validates and renders a deterministic model-facing persona', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mistymoon-persona-load-'))
    const path = join(root, 'persona.json')
    await writeFile(path, `${JSON.stringify(OWNER_PERSONA)}\n`, 'utf8')

    const persona = await loadPersona(path)

    const rendered = renderPersona(persona)
    expect(rendered).toContain('You are Luna.')
    expect(rendered).toContain('Relationship with familiar people:\nRefer only to shared, disclosable work.')
    expect(rendered).toContain('Example 1 Luna: Not yet. I should verify it.')
    expect(rendered).toContain('Deep technical or emotionally sensitive reply: about 800 characters')
  })

  it('rejects malformed private documents before they reach a model', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mistymoon-persona-invalid-'))
    const path = join(root, 'persona.json')
    await writeFile(path, '{"schemaVersion":2,"kind":"mistymoon.persona"}\n', 'utf8')

    await expect(loadPersona(path)).rejects.toThrow(/identity must be an object/)
  })

  it('upgrades a version-one private persona without losing its original fields', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mistymoon-persona-v1-'))
    const path = join(root, 'persona.json')
    await writeFile(path, `${JSON.stringify({
      schemaVersion: 1,
      kind: 'mistymoon.persona',
      displayName: 'Legacy',
      identity: { summary: 'Original identity.', relationship: 'Original relationship.' },
      style: { tone: ['plain'], avoid: ['fabrication'] },
      boundaries: { privateByDefault: true, requireApprovalForExternalActions: true },
    })}\n`, 'utf8')

    const persona = await loadPersona(path)

    expect(persona).toMatchObject({
      schemaVersion: 2,
      displayName: 'Legacy',
      identity: { summary: 'Original identity.', relationship: 'Original relationship.' },
      style: { tone: ['plain'], avoid: ['fabrication'] },
    })
    expect(persona.referenceDialogs).toEqual([])
  })

  it('replaces the DSH persona slot for scoped assemblies and restores it on unload', async () => {
    const privateHome = await mkdtemp(join(tmpdir(), 'mistymoon-persona-plugin-'))
    const personaDirectory = join(privateHome, 'persona')
    await mkdir(personaDirectory)
    await writeFile(join(personaDirectory, 'persona.json'), `${JSON.stringify(OWNER_PERSONA)}\n`, 'utf8')
    const ctx = new Context()
    await ctx.plugin(SystemPrompt, { persona: 'You are a coding agent.' })

    const fiber = await ctx.plugin(Foundation, { home: privateHome })
    const projected = renderPrompt(await ctx.systemPrompt.assemble())

    expect(projected).toContain('You are Luna.')
    expect(projected).not.toContain('You are a coding agent.')

    await fiber.dispose()
    expect(renderPrompt(await ctx.systemPrompt.assemble())).toContain('You are a coding agent.')
  })
})
