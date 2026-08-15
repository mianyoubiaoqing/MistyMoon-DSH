import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import {
  loadPersona,
  projectRoleplay,
  renderPersona,
  renderRoleplaySnapshot,
  RoleplayController,
  type PersonaDocument,
} from '../src/index.js'

const OWNER_PERSONA: PersonaDocument = {
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
}

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

  it('leaves a complete minimal system prompt unchanged', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt, { includeHarnessIdentity: false, persona: 'You are a coding agent.' })
    ctx.systemPrompt.section({ name: 'preset:minimal', order: 10, text: 'Exact coding prompt.', complete: true })

    expect(renderPrompt(await ctx.systemPrompt.assemble())).toBe('Exact coding prompt.')
  })

  it('inserts companion context immediately before the owner message', () => {
    const owner = createUserMessage({
      content: [{ type: 'text', text: 'Fix the failing TypeScript test.' }],
      source: { kind: 'user' },
    })
    const decision: PreStepDecision = { kind: 'enter', messages: [owner] }

    const projected = projectRoleplay(decision, OWNER_PERSONA, 'companion')

    expect(projected.kind).toBe('enter')
    if (projected.kind === 'reject') throw new Error('unexpected rejection')
    expect(projected.messages).toHaveLength(2)
    expect(projected.messages[0]?.source).toMatchObject({
      kind: 'plugin',
      plugin: 'mistymoon-foundation',
      form: 'snapshot',
    })
    expect(projected.messages[0]?.content).toEqual([expect.objectContaining({
      type: 'text',
      text: expect.stringContaining('Do not turn code, commands, plans, diagnostics, or technical decisions into roleplay.'),
    })])
    expect(projected.messages[1]).toBe(owner)
  })

  it('keeps RP selection durable per session without changing DSH settings', () => {
    const events: Array<Record<string, unknown>> = []
    const session = {
      events,
      append(type: string, data: unknown) {
        events.push({ type, data, seq: events.length, time: Date.now() })
      },
    }
    const agent = { session } as unknown as Agent
    const controller = new RoleplayController('companion')

    expect(controller.get(agent)).toEqual({ mode: 'companion' })
    events.push({
      type: 'command/run',
      data: { commandId: 'test-command', name: 'rp', args: ' off', source: { kind: 'user' } },
      seq: 0,
      time: Date.now(),
    })
    expect(controller.get(agent)).toEqual({ mode: 'off' })
    expect(session.events.at(-1)).toMatchObject({ type: 'command/run', data: { name: 'rp', args: ' off' } })
  })

  it('does not project context when RP is off or an initial step has no owner message', () => {
    const owner = createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } })
    const ownerDecision: PreStepDecision = { kind: 'enter', messages: [owner] }
    const continuation: PreStepDecision = { kind: 'enter', messages: [] }

    expect(projectRoleplay(ownerDecision, OWNER_PERSONA, 'off')).toBe(ownerDecision)
    expect(projectRoleplay(continuation, OWNER_PERSONA, 'immersive')).toBe(continuation)
  })

  it('repeats a compact voice reminder on continuation steps without the full immersive persona', () => {
    const continuation: PreStepDecision = { kind: 'enter', messages: [] }

    const projected = projectRoleplay(continuation, OWNER_PERSONA, 'immersive', 2)

    expect(projected.kind).toBe('enter')
    if (projected.kind === 'reject') throw new Error('unexpected rejection')
    expect(projected.messages).toHaveLength(1)
    expect(projected.messages[0]?.source).toMatchObject({
      kind: 'plugin',
      plugin: 'mistymoon-foundation',
      form: 'snapshot',
      summary: 'MistyMoon RP continuation: immersive',
    })
    expect(projected.messages[0]?.content).toEqual([expect.objectContaining({
      type: 'text',
      text: expect.stringContaining('When producing owner-facing prose, keep Luna'),
    })])
    expect(projected.messages[0]?.content).toEqual([expect.objectContaining({
      type: 'text',
      text: expect.not.stringContaining('Example 1 Luna:'),
    })])
  })

  it('uses the full private persona only in immersive presentation', () => {
    const companion = renderRoleplaySnapshot(OWNER_PERSONA, 'companion')
    const immersive = renderRoleplaySnapshot(OWNER_PERSONA, 'immersive')

    expect(companion).toContain('Companion identity: Luna.')
    expect(companion).not.toContain('Example 1 Luna:')
    expect(immersive).toContain('Example 1 Luna: Not yet. I should verify it.')
  })
})
