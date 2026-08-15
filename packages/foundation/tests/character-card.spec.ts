import { describe, expect, it } from 'vitest'
import { parseCharacterCardJson } from '../src/character-card.js'

describe('Character Card JSON import', () => {
  it('normalizes V2 prompt fields into an inert draft and keeps creator notes as metadata', () => {
    const draft = parseCharacterCardJson({
      spec: 'chara_card_v2',
      spec_version: '2.0',
      data: {
        name: 'Example Character',
        description: 'A neutral example used for parser tests.',
        personality: 'Patient and curious.',
        scenario: 'A quiet library.',
        first_mes: 'Hello.',
        mes_example: '<START>\n{{user}}: Hi\n{{char}}: Hello.',
        creator_notes: 'Shown to the owner, never included in prompts.',
        system_prompt: 'Stay in character.',
        post_history_instructions: 'Answer naturally.',
        alternate_greetings: ['Welcome back.'],
        character_book: { name: 'Example lore', entries: [] },
        tags: ['example'],
        creator: 'Fixture Author',
        character_version: '1.0',
        extensions: { 'fixture/color': '#778899' },
      },
    })

    expect(draft).toMatchObject({
      kind: 'mistymoon.persona-import-draft',
      source: { generation: 'v2', specVersion: '2.0' },
      character: { name: 'Example Character', personality: 'Patient and curious.' },
      instructions: { systemPrompt: 'Stay in character.', postHistoryInstructions: 'Answer naturally.' },
      metadata: { creatorNotes: 'Shown to the owner, never included in prompts.' },
      extensions: { 'fixture/color': '#778899' },
      warnings: [],
    })
  })

  it('preserves unknown V3 fields and warns about newer minor specifications', () => {
    const draft = parseCharacterCardJson({
      spec: 'chara_card_v3',
      spec_version: '3.1',
      vendor_top_level: true,
      data: {
        name: 'Future Example',
        nickname: 'Future',
        description: '',
        personality: '',
        scenario: '',
        group_only_greetings: [],
        source: ['https://example.invalid/card'],
        extensions: {},
        future_field: { enabled: true },
      },
    })

    expect(draft.character.nickname).toBe('Future')
    expect(draft.unknown).toEqual({
      root: { vendor_top_level: true },
      data: { future_field: { enabled: true } },
    })
    expect(draft.warnings).toEqual([
      'Character Card 3.1 is newer than the supported 3.0 baseline; unknown fields were preserved.',
    ])
  })

  it('parses legacy V1 cards without treating example dialogue as memory', () => {
    const draft = parseCharacterCardJson({
      name: 'Legacy Example',
      description: 'A legacy fixture.',
      personality: 'Measured.',
      scenario: 'A test scene.',
      first_mes: 'Hi.',
      mes_example: 'Example only.',
    })

    expect(draft.source.generation).toBe('v1')
    expect(draft.exampleDialog).toBe('Example only.')
    expect(draft.warnings).toHaveLength(1)
  })

  it('rejects unsupported specs and non-JSON extension values', () => {
    expect(() => parseCharacterCardJson({ spec: 'unknown', data: {} })).toThrow(/unsupported Character Card spec/)
    expect(() => parseCharacterCardJson({
      spec: 'chara_card_v2',
      spec_version: '2.0',
      data: { name: 'Example', extensions: { invalid: undefined } },
    })).toThrow(/characterCard\.data\.extensions\.invalid/)
  })
})
