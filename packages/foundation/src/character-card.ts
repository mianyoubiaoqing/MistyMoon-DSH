/** Character Card JSON parsing into an inert, owner-reviewable persona draft. */

import type { PersonaDocument, PersonaReferenceDialog } from './persona-document.js'

/** Character Card generations recognized by the import boundary. */
export type CharacterCardGeneration = 'v1' | 'v2' | 'v3'

/** JSON-compatible value retained without interpreting application extensions. */
export type CharacterCardJsonValue = null | boolean | number | string | CharacterCardJsonValue[] | {
  [key: string]: CharacterCardJsonValue
}

/** Normalized draft that cannot become an active persona without a later publish operation. */
export interface CharacterCardImportDraft {
  schemaVersion: 1
  kind: 'mistymoon.persona-import-draft'
  source: {
    generation: CharacterCardGeneration
    specVersion?: string
  }
  character: {
    name: string
    nickname?: string
    description: string
    personality: string
    scenario: string
  }
  instructions: {
    systemPrompt: string
    postHistoryInstructions: string
  }
  exampleDialog: string
  greetings: {
    first: string
    alternate: string[]
    groupOnly: string[]
  }
  metadata: {
    creatorNotes: string
    creator: string
    characterVersion: string
    tags: string[]
    sources: string[]
  }
  characterBook?: CharacterCardJsonValue
  extensions: Record<string, CharacterCardJsonValue>
  unknown: {
    root: Record<string, CharacterCardJsonValue>
    data: Record<string, CharacterCardJsonValue>
  }
  warnings: string[]
}

/** Owner-controlled mapping from an inert card draft into a MistyMoon persona draft. */
export interface CharacterCardPersonaMapping {
  displayName: 'name' | 'nickname'
  includeDescription: boolean
  includePersonality: boolean
  includeScenarioAsRelationship: boolean
  includeSystemPrompt: boolean
  includePostHistoryInstructions: boolean
  includeExampleDialog: boolean
}

/** Proposed persona plus warnings produced while mapping non-native fields. */
export interface CharacterCardMappingResult {
  persona: PersonaDocument
  warnings: string[]
}

/** Safe mapping defaults; high-authority card instructions remain disabled. */
export const DEFAULT_CHARACTER_CARD_MAPPING: CharacterCardPersonaMapping = Object.freeze({
  displayName: 'name',
  includeDescription: true,
  includePersonality: true,
  includeScenarioAsRelationship: false,
  includeSystemPrompt: false,
  includePostHistoryInstructions: true,
  includeExampleDialog: true,
})

const MAX_JSON_DEPTH = 32
const MAX_JSON_NODES = 20_000
const MAX_TEXT_LENGTH = 1_000_000

function validateJsonTree(value: unknown): void {
  const pending: Array<{ value: unknown; path: string; depth: number }> = [{ value, path: 'characterCard', depth: 0 }]
  let nodes = 0
  while (pending.length > 0) {
    const current = pending.pop()
    if (current === undefined) break
    nodes += 1
    if (nodes > MAX_JSON_NODES) throw new Error(`characterCard exceeds ${MAX_JSON_NODES} JSON values`)
    if (current.depth > MAX_JSON_DEPTH) throw new Error(`${current.path} exceeds the maximum JSON nesting depth`)
    const item = current.value
    if (item === null || typeof item === 'boolean') continue
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) throw new Error(`${current.path} must contain a finite JSON number`)
      continue
    }
    if (typeof item === 'string') {
      if (item.length > MAX_TEXT_LENGTH) throw new Error(`${current.path} exceeds ${MAX_TEXT_LENGTH} characters`)
      continue
    }
    if (Array.isArray(item)) {
      item.forEach((child, index) => pending.push({ value: child, path: `${current.path}[${index}]`, depth: current.depth + 1 }))
      continue
    }
    const source = object(item, current.path)
    for (const [key, child] of Object.entries(source)) {
      pending.push({ value: child, path: `${current.path}.${key}`, depth: current.depth + 1 })
    }
  }
}

function object(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${path} must be an object`)
  }
  return value as Record<string, unknown>
}

function text(value: unknown, path: string): string {
  if (typeof value !== 'string') throw new Error(`${path} must be a string`)
  return value
}

function optionalText(value: unknown, path: string): string {
  return value === undefined ? '' : text(value, path)
}

function texts(value: unknown, path: string): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error(`${path} must be an array of strings`)
  return value.map((item, index) => text(item, `${path}[${index}]`))
}

function jsonValue(value: unknown, path: string, depth = 0): CharacterCardJsonValue {
  if (depth > 32) throw new Error(`${path} exceeds the maximum JSON nesting depth`)
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`${path} must contain a finite JSON number`)
    return value
  }
  if (Array.isArray(value)) return value.map((item, index) => jsonValue(item, `${path}[${index}]`, depth + 1))
  const source = object(value, path)
  return Object.fromEntries(
    Object.entries(source).map(([key, item]) => [key, jsonValue(item, `${path}.${key}`, depth + 1)]),
  )
}

function jsonRecord(value: unknown, path: string): Record<string, CharacterCardJsonValue> {
  if (value === undefined) return {}
  return jsonValue(object(value, path), path) as Record<string, CharacterCardJsonValue>
}

function unknownFields(
  value: Record<string, unknown>,
  known: ReadonlySet<string>,
  path: string,
): Record<string, CharacterCardJsonValue> {
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !known.has(key))
      .map(([key, item]) => [key, jsonValue(item, `${path}.${key}`)]),
  )
}

const COMMON_DATA_FIELDS = new Set([
  'name',
  'nickname',
  'description',
  'personality',
  'scenario',
  'system_prompt',
  'post_history_instructions',
  'mes_example',
  'first_mes',
  'alternate_greetings',
  'group_only_greetings',
  'creator_notes',
  'creator_notes_multilingual',
  'creator',
  'character_version',
  'tags',
  'source',
  'character_book',
  'extensions',
  'assets',
  'creation_date',
  'modification_date',
])

function commonDraft(
  generation: CharacterCardGeneration,
  specVersion: string | undefined,
  data: Record<string, unknown>,
  unknownRoot: Record<string, CharacterCardJsonValue>,
  warnings: string[],
): CharacterCardImportDraft {
  const characterBook = data.character_book === undefined
    ? undefined
    : jsonValue(data.character_book, 'characterCard.data.character_book')
  return {
    schemaVersion: 1,
    kind: 'mistymoon.persona-import-draft',
    source: {
      generation,
      ...(specVersion === undefined ? {} : { specVersion }),
    },
    character: {
      name: text(data.name, 'characterCard.data.name'),
      ...(data.nickname === undefined ? {} : { nickname: text(data.nickname, 'characterCard.data.nickname') }),
      description: optionalText(data.description, 'characterCard.data.description'),
      personality: optionalText(data.personality, 'characterCard.data.personality'),
      scenario: optionalText(data.scenario, 'characterCard.data.scenario'),
    },
    instructions: {
      systemPrompt: optionalText(data.system_prompt, 'characterCard.data.system_prompt'),
      postHistoryInstructions: optionalText(
        data.post_history_instructions,
        'characterCard.data.post_history_instructions',
      ),
    },
    exampleDialog: optionalText(data.mes_example, 'characterCard.data.mes_example'),
    greetings: {
      first: optionalText(data.first_mes, 'characterCard.data.first_mes'),
      alternate: texts(data.alternate_greetings, 'characterCard.data.alternate_greetings'),
      groupOnly: texts(data.group_only_greetings, 'characterCard.data.group_only_greetings'),
    },
    metadata: {
      creatorNotes: optionalText(data.creator_notes, 'characterCard.data.creator_notes'),
      creator: optionalText(data.creator, 'characterCard.data.creator'),
      characterVersion: optionalText(data.character_version, 'characterCard.data.character_version'),
      tags: texts(data.tags, 'characterCard.data.tags'),
      sources: texts(data.source, 'characterCard.data.source'),
    },
    ...(characterBook === undefined ? {} : { characterBook }),
    extensions: jsonRecord(data.extensions, 'characterCard.data.extensions'),
    unknown: {
      root: unknownRoot,
      data: unknownFields(data, COMMON_DATA_FIELDS, 'characterCard.data'),
    },
    warnings,
  }
}

function parseV1(root: Record<string, unknown>): CharacterCardImportDraft {
  const warnings = [
    'Character Card V1 has no explicit specification marker; verify the imported fields before publishing.',
  ]
  return commonDraft(
    'v1',
    undefined,
    root,
    {},
    warnings,
  )
}

function parseVersioned(root: Record<string, unknown>, generation: 'v2' | 'v3'): CharacterCardImportDraft {
  const specVersion = text(root.spec_version, 'characterCard.spec_version')
  const expected = generation === 'v2' ? 2 : 3
  const parsedVersion = Number.parseFloat(specVersion)
  const warnings: string[] = []
  if (!Number.isFinite(parsedVersion) || Math.floor(parsedVersion) !== expected) {
    warnings.push(`Character Card reports spec version ${JSON.stringify(specVersion)}; supported major version is ${expected}.`)
  } else if (parsedVersion > expected) {
    warnings.push(`Character Card ${specVersion} is newer than the supported ${expected}.0 baseline; unknown fields were preserved.`)
  }
  const data = object(root.data, 'characterCard.data')
  return commonDraft(
    generation,
    specVersion,
    data,
    unknownFields(root, new Set(['spec', 'spec_version', 'data']), 'characterCard'),
    warnings,
  )
}

/**
 * Parse a Character Card JSON value into an inert import draft.
 * @param value - Untrusted JSON value read from a V1, V2, or V3 card.
 * @returns Normalized private draft; no field is executed or published.
 */
export function parseCharacterCardJson(value: unknown): CharacterCardImportDraft {
  validateJsonTree(value)
  const root = object(value, 'characterCard')
  if (root.spec === 'chara_card_v2') return parseVersioned(root, 'v2')
  if (root.spec === 'chara_card_v3') return parseVersioned(root, 'v3')
  if (root.spec !== undefined) throw new Error(`unsupported Character Card spec ${JSON.stringify(root.spec)}`)
  return parseV1(root)
}

/** Validate mapping controls received from the local settings UI. */
export function parseCharacterCardPersonaMapping(value: unknown): CharacterCardPersonaMapping {
  const root = object(value, 'characterCardMapping')
  const keys = Object.keys(DEFAULT_CHARACTER_CARD_MAPPING)
  if (Object.keys(root).length !== keys.length || keys.some(key => !(key in root))) {
    throw new Error('characterCardMapping must contain exactly the supported mapping fields')
  }
  if (root.displayName !== 'name' && root.displayName !== 'nickname') {
    throw new Error('characterCardMapping.displayName must be name or nickname')
  }
  for (const key of keys.filter(key => key !== 'displayName')) {
    if (typeof root[key] !== 'boolean') throw new Error(`characterCardMapping.${key} must be a boolean`)
  }
  return root as unknown as CharacterCardPersonaMapping
}

function appendText(existing: string, heading: string, imported: string): string {
  return imported.trim() === '' ? existing : [existing, `${heading}:\n${imported.trim()}`].filter(Boolean).join('\n\n')
}

function parseReferenceDialogs(source: string, characterName: string): PersonaReferenceDialog[] {
  const escapedName = characterName.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  const user = /^\s*(?:\{\{user\}\}|user)\s*:\s*(.*)$/iu
  const assistant = new RegExp(`^\\s*(?:\\{\\{char\\}\\}|${escapedName})\\s*:\\s*(.*)$`, 'iu')
  const dialogs: PersonaReferenceDialog[] = []
  let pendingUser: string | undefined
  for (const rawLine of source.replaceAll('<START>', '').split(/\r?\n/u)) {
    const userMatch = user.exec(rawLine)
    if (userMatch !== null) {
      pendingUser = userMatch[1]?.trim()
      continue
    }
    const assistantMatch = assistant.exec(rawLine)
    const response = assistantMatch?.[1]?.trim()
    if (pendingUser !== undefined && pendingUser !== '' && response !== undefined && response !== '') {
      dialogs.push({ user: pendingUser, assistant: response })
      pendingUser = undefined
      if (dialogs.length === 24) break
    }
  }
  return dialogs
}

/**
 * Map reviewed Character Card fields onto an existing private persona.
 * Metadata, greetings, lore books, extensions, and unknown fields never enter the result.
 */
export function mapCharacterCardToPersona(
  draft: CharacterCardImportDraft,
  base: PersonaDocument,
  mappingValue: unknown,
): CharacterCardMappingResult {
  const mapping = parseCharacterCardPersonaMapping(mappingValue)
  const warnings = [...draft.warnings]
  const requestedName = mapping.displayName === 'nickname' ? draft.character.nickname : draft.character.name
  const displayName = requestedName?.trim() === '' || requestedName === undefined
    ? draft.character.name
    : requestedName
  const identityParts = [
    ...(mapping.includeDescription && draft.character.description.trim() !== ''
      ? [draft.character.description.trim()]
      : []),
    ...(mapping.includePersonality && draft.character.personality.trim() !== ''
      ? [`Personality: ${draft.character.personality.trim()}`]
      : []),
  ]
  const referenceDialogs = mapping.includeExampleDialog
    ? parseReferenceDialogs(draft.exampleDialog, draft.character.name)
    : []
  if (mapping.includeExampleDialog && draft.exampleDialog.trim() !== '' && referenceDialogs.length === 0) {
    warnings.push('Example dialogue could not be mapped into user/character pairs and was left out of the persona draft.')
  }
  if (mapping.includeSystemPrompt && draft.instructions.systemPrompt.trim() !== '') {
    warnings.push('The imported card system prompt is subordinate to DSH instructions and MistyMoon operational safeguards.')
  }
  return {
    persona: {
      ...structuredClone(base),
      displayName,
      identity: {
        ...base.identity,
        summary: identityParts.length === 0 ? base.identity.summary : identityParts.join('\n\n'),
        relationship: mapping.includeScenarioAsRelationship
          ? appendText(base.identity.relationship, 'Imported scenario', draft.character.scenario)
          : base.identity.relationship,
      },
      style: {
        ...base.style,
        instructions: mapping.includePostHistoryInstructions
          ? appendText(base.style.instructions, 'Imported response instructions', draft.instructions.postHistoryInstructions)
          : base.style.instructions,
      },
      advancedInstructions: mapping.includeSystemPrompt
        ? appendText(base.advancedInstructions, 'Imported Character Card system prompt', draft.instructions.systemPrompt)
        : base.advancedInstructions,
      referenceDialogs: referenceDialogs.length === 0 ? base.referenceDialogs : referenceDialogs,
    },
    warnings,
  }
}
