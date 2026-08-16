import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import * as FoundationPlugin from '../src/index.js'
import {
  DEFAULT_TURN_VOICE_MAX_CHARS,
  FINAL_REPLY_TOOL,
  FINAL_VOICE_REFRESH_CONSUMED_SECTION,
  FINAL_VOICE_REFRESH_SECTION,
  MIN_TURN_VOICE_MAX_CHARS,
  TURN_VOICE_CONSUMED_SECTION,
  TURN_VOICE_SECTION,
  TURN_VOICE_SUPERSEDED_SECTION,
  loadPersona,
  renderFinalVoiceRefresh,
  renderFinalVoiceRefreshConsumed,
  renderPersona,
  renderTurnVoice,
  renderTurnVoiceConsumed,
  renderTurnVoiceSuperseded,
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

describe('private persona documents', () => {
  it('validates and renders a deterministic model-facing persona', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mistymoon-persona-load-'))
    const path = join(root, 'persona.json')
    await writeFile(path, `${JSON.stringify(OWNER_PERSONA)}\n`, 'utf8')

    const persona = await loadPersona(path)

    const rendered = renderPersona(persona)
    expect(rendered).toContain('You are Luna.')
    expect(rendered).toContain('Relationship with familiar people:\nRefer only to shared, disclosable work.')
    expect(rendered).toContain('Example 1 Luna: Not yet. I should verify it.')
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

    expect(persona).toMatchObject({ schemaVersion: 2, displayName: 'Legacy' })
    expect(persona.referenceDialogs).toEqual([])
  })
})

describe('two-phase voice rendering', () => {
  it('renders the initial profile with output-presentation fields and keeps immersive full only in refresh', () => {
    const capsule = renderTurnVoice(OWNER_PERSONA, DEFAULT_TURN_VOICE_MAX_CHARS)
    const companion = renderFinalVoiceRefresh(OWNER_PERSONA, 'companion')
    const immersive = renderFinalVoiceRefresh(OWNER_PERSONA, 'immersive')

    for (const phrase of ['MistyMoon output presentation profile', 'Activation', 'Operational behavior']) {
      expect(capsule).toContain(phrase)
    }
    expect(capsule).toContain('Speaker label: Luna.')
    expect(capsule).toContain('Relationship register: Continue shared work without inventing shared history.')
    expect(capsule).toContain('Voice traits: warm; plain-spoken.')
    expect(capsule).not.toContain('Example 1 Luna:')
    expect(capsule).not.toContain(OWNER_PERSONA.style.instructions)
    expect(capsule.length).toBeLessThanOrEqual(DEFAULT_TURN_VOICE_MAX_CHARS)
    expect(companion).toContain('MistyMoon final-voice-refresh context.')
    expect(companion).toContain('Speaker label: Luna.')
    expect(companion).not.toContain('Companion identity')
    expect(companion).not.toContain('Example 1 Luna:')
    expect(companion).toContain('applies only to the single owner-facing assistant reply')
    expect(immersive).toContain('MistyMoon final-voice-refresh context.')
    expect(immersive).toContain('Example 1 Luna: Not yet. I should verify it.')
    for (const text of [companion, immersive]) {
      expect(text).toContain('DeepSeek Harness system instructions')
      expect(text).toContain('Do not change facts, code, commands, plans, diagnostics, tool results, permissions, or safety decisions for presentation.')
    }
    expect(capsule).toContain('DeepSeek Harness question understanding, facts, code, commands, plans, diagnostics, tools, permissions, approvals, and safety decisions remain unchanged.')
  })

  it('enforces the mandatory block minimum and adds optional fields only whole', () => {
    const minimal = renderTurnVoice(OWNER_PERSONA, MIN_TURN_VOICE_MAX_CHARS)

    expect(minimal.length).toBeLessThanOrEqual(MIN_TURN_VOICE_MAX_CHARS)
    expect(minimal).toContain('MistyMoon output presentation profile')
    expect(minimal).toContain('Activation')
    expect(minimal).toContain('Operational behavior')
    expect(minimal).not.toContain('…')
    expect(() => renderTurnVoice(OWNER_PERSONA, MIN_TURN_VOICE_MAX_CHARS - 1)).toThrow(/at least/)

    const fittingField = renderTurnVoice({
      ...OWNER_PERSONA,
      identity: {
        ...OWNER_PERSONA.identity,
        relationship: 'R'.repeat(300),
      },
      style: {
        ...OWNER_PERSONA.style,
        instructions: 'STYLE_INSTRUCTION_SENTINEL',
      },
      referenceDialogs: [{ user: 'Sentinel user.', assistant: 'REFERENCE_DIALOG_SENTINEL' }],
    }, DEFAULT_TURN_VOICE_MAX_CHARS)
    expect(fittingField).not.toContain('STYLE_INSTRUCTION_SENTINEL')
    expect(fittingField).not.toContain('REFERENCE_DIALOG_SENTINEL')
    expect(fittingField).not.toContain('…')
    expect(fittingField.length).toBeLessThanOrEqual(DEFAULT_TURN_VOICE_MAX_CHARS)
    expect(fittingField).toContain(`Relationship register: ${'R'.repeat(300)}`)

    const oversizedField = renderTurnVoice({
      ...OWNER_PERSONA,
      identity: {
        ...OWNER_PERSONA.identity,
        relationship: 'R'.repeat(DEFAULT_TURN_VOICE_MAX_CHARS),
      },
      style: {
        ...OWNER_PERSONA.style,
        instructions: 'STYLE_INSTRUCTION_SENTINEL',
      },
      referenceDialogs: [{ user: 'Sentinel user.', assistant: 'REFERENCE_DIALOG_SENTINEL' }],
    }, DEFAULT_TURN_VOICE_MAX_CHARS)
    expect(oversizedField).not.toContain('STYLE_INSTRUCTION_SENTINEL')
    expect(oversizedField).not.toContain('REFERENCE_DIALOG_SENTINEL')
    expect(oversizedField).not.toContain('…')
    expect(oversizedField).not.toContain('Relationship register:')
    expect(oversizedField.length).toBeLessThanOrEqual(DEFAULT_TURN_VOICE_MAX_CHARS)
  })

  it('renders neutral lifecycle records without instructions or persona content', () => {
    const consumed = renderTurnVoiceConsumed()
    const superseded = renderTurnVoiceSuperseded()
    const refreshConsumed = renderFinalVoiceRefreshConsumed()

    expect(consumed).toBe('MistyMoon projection lifecycle record: owner-turn output profile consumed.')
    expect(superseded).toBe('MistyMoon projection lifecycle record: owner-turn output profile superseded by the prepared final profile.')
    expect(refreshConsumed).toBe('MistyMoon projection lifecycle record: prepared final output profile consumed.')
    for (const text of [consumed, superseded, refreshConsumed]) {
      expect(text).not.toContain('Luna')
      expect(text).not.toContain('warm')
      expect(text.toLowerCase()).not.toMatch(/no persona|ignore persona|do not roleplay|apply now/)
    }
  })
})

describe('revised red regression: output presentation renderer', () => {
  it('renders field-aware output presentation without identity arbitration or truncation', () => {
    const persona: PersonaDocument = {
      ...OWNER_PERSONA,
      style: {
        ...OWNER_PERSONA.style,
        instructions: 'STYLE_INSTRUCTION_SENTINEL',
      },
      referenceDialogs: [{ user: 'Sentinel user.', assistant: 'REFERENCE_DIALOG_SENTINEL' }],
    }
    const failures: string[] = []
    const large = renderTurnVoice(persona, 10000)
    const required = [
      'MistyMoon output presentation profile',
      'Activation',
      'Operational behavior',
      'Speaker label',
      'Relationship register',
      'Voice traits',
    ]
    for (const phrase of required) {
      if (!large.includes(phrase)) failures.push(`required renderer phrase missing: ${phrase}`)
    }
    if (!large.toLowerCase().includes('no tool call') || !large.toLowerCase().includes('ends the current owner turn')) {
      failures.push('activation block does not limit application to a tool-free owner-turn-ending response')
    }
    const forbidden = ['Companion identity', 'Expression guidance', 'roleplay', 'persona']
    for (const phrase of forbidden) {
      if (large.toLowerCase().includes(phrase.toLowerCase())) failures.push(`forbidden renderer phrase present: ${phrase}`)
    }
    for (const sentinel of ['STYLE_INSTRUCTION_SENTINEL', 'REFERENCE_DIALOG_SENTINEL']) {
      if (large.includes(sentinel)) failures.push(`initial profile contains sentinel: ${sentinel}`)
    }
    const small = renderTurnVoice(persona, MIN_TURN_VOICE_MAX_CHARS)
    if (small.endsWith('…')) failures.push('small-budget render ends with a truncation ellipsis')
    if (!small.includes('MistyMoon output presentation profile')) failures.push('small-budget render lost its mandatory header')
    if (!small.includes('Activation') || !small.includes('Operational behavior')) {
      failures.push('small-budget render lost a mandatory block')
    }
    expect(failures).toEqual([])
  })
})

describe('RP mode folding', () => {
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
})

describe('Foundation composition', () => {
  it('registers exactly one neutral prepare tool and no system-prompt persona provider', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mistymoon-compose-'))
    const ctx = new Context()
    await ctx.plugin(SystemPrompt, { includeHarnessIdentity: false, persona: 'Neutral preset persona.' })
    await ctx.plugin(ToolRuntime)
    const fiber = await ctx.plugin(FoundationPlugin, { home: root, defaultRoleplayMode: 'companion' })

    expect(FoundationPlugin.inject).toEqual(['tools'])
    const assembly = await ctx.systemPrompt.assemble()
    expect(assembly.sections.map(section => section.name)).toEqual(['deployment:persona'])
    expect(assembly.contexts).toEqual([])

    const tool = ctx.tools.get(FINAL_REPLY_TOOL)
    expect(tool?.name).toBe(FINAL_REPLY_TOOL)
    expect(JSON.stringify(tool)).not.toMatch(/Luna|warm|plain-spoken|companion|immersive/)
    expect(tool?.presentCall?.({})).toMatchObject({
      card: 'generic',
      title: 'Prepare final reply',
    })
    const rendered = tool?.output.render({}, { status: 'armed' })
    expect(rendered?.some(block => block.type === 'text' && block.text.includes('Final reply prepared'))).toBe(true)
    expect(JSON.stringify(rendered)).not.toMatch(/Luna|warm|plain-spoken/)

    await fiber.dispose()
    expect(ctx.tools.get(FINAL_REPLY_TOOL)).toBeUndefined()
  })

  it('stays pending on the tools capability and fails loudly on duplicate registration', async () => {
    const firstHome = await mkdtemp(join(tmpdir(), 'mistymoon-compose-pending-'))
    const pending = new Context()
    const pendingFiber = pending.plugin(FoundationPlugin, { home: firstHome, defaultRoleplayMode: 'companion' })
    await pendingFiber
    expect(pendingFiber.state).toBe(0) // FiberState.PENDING: tools service absent
    expect(pendingFiber.inject).toHaveProperty('tools')

    const secondHome = await mkdtemp(join(tmpdir(), 'mistymoon-compose-duplicate-'))
    const ctx = new Context()
    await ctx.plugin(SystemPrompt, { includeHarnessIdentity: false, persona: 'Neutral preset persona.' })
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(FoundationPlugin, { home: firstHome, defaultRoleplayMode: 'companion' })
    await expect(ctx.plugin(FoundationPlugin, { home: secondHome, defaultRoleplayMode: 'companion' }))
      .rejects.toThrow(/has been registered|already registered/)
    expect(ctx.tools.get(FINAL_REPLY_TOOL)?.name).toBe(FINAL_REPLY_TOOL)
  })

  it('leaves a complete minimal system prompt unchanged', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt, { includeHarnessIdentity: false, persona: 'You are a coding agent.' })
    ctx.systemPrompt.section({ name: 'preset:minimal', order: 10, text: 'Exact coding prompt.', complete: true })

    expect(renderPrompt(await ctx.systemPrompt.assemble())).toBe('Exact coding prompt.')
  })

  it('exposes the two-phase and lifecycle section identities without private content', () => {
    expect(DEFAULT_TURN_VOICE_MAX_CHARS).toBe(1200)
    expect(MIN_TURN_VOICE_MAX_CHARS).toBeGreaterThan(0)
    expect(TURN_VOICE_SECTION).toBe('mistymoon:turn-voice')
    expect(TURN_VOICE_CONSUMED_SECTION).toBe('mistymoon:turn-voice-consumed')
    expect(TURN_VOICE_SUPERSEDED_SECTION).toBe('mistymoon:turn-voice-superseded')
    expect(FINAL_VOICE_REFRESH_SECTION).toBe('mistymoon:final-voice-refresh')
    expect(FINAL_VOICE_REFRESH_CONSUMED_SECTION).toBe('mistymoon:final-voice-refresh-consumed')
  })
})
