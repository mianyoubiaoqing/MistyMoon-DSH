import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { initializePersona } from '@mistymoon/dsh-foundation/persona-home'
import { openMemoryArchive } from '@mistymoon/dsh-memory'
import {
  applyMistyMoonCharacterCard,
  approveMistyMoonCandidate,
  publishMistyMoonPersona,
  readMistyMoonCandidates,
  readMistyMoonSettings,
  rejectMistyMoonCandidate,
  saveMistyMoonSettings,
  previewMistyMoonCharacterCard,
} from '../src/index.js'
import { DEFAULT_CHARACTER_CARD_MAPPING } from '@mistymoon/dsh-foundation/character-card'

const template = join(import.meta.dirname, '..', '..', 'foundation', 'personas', 'template', 'persona.json')

describe('MistyMoon settings Host API', () => {
  it('saves persona changes as a draft and publishes only on explicit request', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mistymoon-settings-'))
    await initializePersona({ privateHome: home, templatePath: template })
    const before = await readMistyMoonSettings(home)
    const saved = await saveMistyMoonSettings(home, {
      persona: { ...before.persona, displayName: 'Local Misty' },
      recallLimit: 12,
    })

    expect(saved.persona.displayName).toBe('Local Misty')
    expect(saved.activePersona.displayName).toBe(before.activePersona.displayName)
    expect(saved.hasPersonaDraft).toBe(true)
    expect(saved.personaPreview).toContain('You are Local Misty.')
    expect(saved.recallLimit).toBe(12)
    expect(JSON.parse(await readFile(join(home, 'persona', 'persona.json'), 'utf8')).displayName)
      .toBe(before.activePersona.displayName)
    expect(JSON.parse(await readFile(join(home, 'settings', 'settings.json'), 'utf8'))).toEqual({
      schemaVersion: 1,
      recallLimit: 12,
    })

    const published = await publishMistyMoonPersona(home)
    expect(published.activePersona.displayName).toBe('Local Misty')
    expect(published.hasPersonaDraft).toBe(false)
    expect(published.personaVersions).toHaveLength(1)
  })

  it('rejects unknown settings fields', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mistymoon-settings-invalid-'))
    await expect(saveMistyMoonSettings(home, {
      persona: {},
      recallLimit: 8,
      path: 'elsewhere',
    })).rejects.toThrow('must contain persona and recallLimit')
  })

  it('previews a card without mutation and applies it only as a persona draft', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mistymoon-card-settings-'))
    await initializePersona({ privateHome: home, templatePath: template })
    const source = Buffer.from(JSON.stringify({
      spec: 'chara_card_v2', spec_version: '2.0',
      data: { name: 'Imported Example', description: 'A neutral imported fixture.', system_prompt: 'Unsafe by default.' },
    }))
    const request = {
      fileName: 'example.json',
      contentBase64: source.toString('base64'),
      mapping: DEFAULT_CHARACTER_CARD_MAPPING,
    }

    const preview = await previewMistyMoonCharacterCard(home, request)
    expect(preview).toMatchObject({
      source: { fileName: 'example.json', container: 'json' },
      draft: { character: { name: 'Imported Example' } },
      persona: { displayName: 'Imported Example', advancedInstructions: '' },
    })
    expect((await readMistyMoonSettings(home)).hasPersonaDraft).toBe(false)

    const applied = await applyMistyMoonCharacterCard(home, request)
    expect(applied.hasPersonaDraft).toBe(true)
    expect(applied.persona.displayName).toBe('Imported Example')
    expect(applied.activePersona.displayName).not.toBe('Imported Example')
  })

  it('reviews candidates through the same archive used by memory recall', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mistymoon-candidate-settings-'))
    const ids = ['candidate-1', 'memory-1', 'event-1', 'candidate-2', 'event-2']
    const archive = await openMemoryArchive({
      path: join(home, 'memory', 'memories.jsonl'),
      createId: () => ids.shift() ?? 'unexpected-id',
      now: () => new Date('2026-08-16T00:00:00.000Z'),
    })
    const approvedCandidate = await archive.propose({
      sourceMessageId: 'proposal-1',
      content: '主人周末会整理书桌。',
      visibility: 'personal',
    })
    const rejectedCandidate = await archive.propose({
      sourceMessageId: 'proposal-2',
      content: '主人每天凌晨四点起床。',
      visibility: 'personal',
    })

    expect(readMistyMoonCandidates(archive)).toEqual([rejectedCandidate, approvedCandidate])
    await approveMistyMoonCandidate(archive, approvedCandidate.id, 'approve-1')
    await rejectMistyMoonCandidate(archive, rejectedCandidate.id, 'reject-1')

    expect(readMistyMoonCandidates(archive)).toEqual([])
    expect(archive.recall({ query: '周末' })).toEqual([
      expect.objectContaining({ content: '主人周末会整理书桌。', sourceCandidateId: approvedCandidate.id }),
    ])
    expect(archive.recall({ query: '凌晨四点' })).toEqual([])
  })
})
