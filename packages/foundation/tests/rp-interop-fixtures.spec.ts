import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { DEFAULT_CHARACTER_CARD_MAPPING, parseCharacterCardJson } from '../src/character-card.js'
import { parseCharacterCardFile } from '../src/character-card-container.js'

const FIXTURES = fileURLToPath(new URL('../../../fixtures/rp-interop/', import.meta.url))

async function json(name: string): Promise<unknown> {
  return JSON.parse(await readFile(`${FIXTURES}/${name}`, 'utf8'))
}

describe('neutral RP interoperability fixtures', () => {
  it('parses V2/V3 and preserves unknown extensions without prompt authority', async () => {
    const v2 = parseCharacterCardJson(await json('character-v2.json'))
    const v3 = parseCharacterCardJson(await json('character-v3.json'))

    expect(v2.source.generation).toBe('v2')
    expect(v3.source.generation).toBe('v3')
    expect(JSON.stringify(v2.extensions)).toContain('mistymoon_fixture_unknown')
    expect(JSON.stringify(v3.extensions)).toContain('future_vendor_field')
    expect(DEFAULT_CHARACTER_CARD_MAPPING.includeSystemPrompt).toBe(false)
  })

  it('decodes the checked-in CHARX into the same inert V3 draft', async () => {
    const encoded = (await readFile(`${FIXTURES}/character-v3.charx.b64`, 'utf8')).trim()
    const preview = await parseCharacterCardFile('neutral-character.charx', Buffer.from(encoded, 'base64'))

    expect(preview.source.container).toBe('charx')
    expect(preview.draft.source.generation).toBe('v3')
    expect(preview.draft.character.name).toBe('Archive Curator')
    expect(DEFAULT_CHARACTER_CARD_MAPPING.includeSystemPrompt).toBe(false)
  })

  it('keeps Character, Owner Persona, Relationship, speaker, summary, and memory scopes separate', async () => {
    const owner = await json('owner-persona.json') as Record<string, unknown>
    const relationship = await json('relationship.json') as Record<string, unknown>
    const speaker = await json('speaker-policy.json') as {
      cases: Array<{ activeSpeakerId: string }>
      maxActiveSpeakersPerRequest: number
    }
    const summary = await json('summary-revisions.json') as {
      revisions: Array<{ revision: number; status: string }>
    }
    const scopes = await json('memory-scopes.json') as {
      queries: Array<{ allowedSourceIds: string[]; forbiddenSourceIds: string[] }>
    }

    expect(owner.mustNotBeOverwrittenByCharacterImport).toBe(true)
    expect(relationship.mustNotBeOverwrittenByCharacterImport).toBe(true)
    expect(speaker.maxActiveSpeakersPerRequest).toBe(1)
    expect(speaker.cases.every(testCase => testCase.activeSpeakerId !== '')).toBe(true)
    expect(summary.revisions.map(revision => [revision.revision, revision.status])).toEqual([
      [1, 'paused'], [2, 'invalidated'], [3, 'active'],
    ])
    expect(scopes.queries.every(query => query.allowedSourceIds
      .every(source => !query.forbiddenSourceIds.includes(source)))).toBe(true)
  })
})
