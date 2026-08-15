import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/** Supported response-length preset names. */
export type PersonaResponseBudgetName = 'brief' | 'normal' | 'deep'

/** One approved example that demonstrates the persona without becoming live memory. */
export interface PersonaReferenceDialog {
  user: string
  assistant: string
}

/** Character and token guidance for one response-length preset. */
export interface PersonaResponseBudget {
  targetCharacters: number
  maxOutputTokens: number
}

/** Versioned owner persona document stored only in the private MistyMoon home. */
export interface PersonaDocument {
  schemaVersion: 2
  kind: 'mistymoon.persona'
  displayName: string
  identity: {
    summary: string
    relationship: string
    familiarRelationship: string
    strangerRelationship: string
  }
  style: {
    tone: string[]
    instructions: string
    avoid: string[]
  }
  advancedInstructions: string
  referenceDialogs: PersonaReferenceDialog[]
  responseBudgets: Record<PersonaResponseBudgetName, PersonaResponseBudget>
  boundaries: {
    privateByDefault: boolean
    requireApprovalForExternalActions: boolean
  }
}

const DEFAULT_RESPONSE_BUDGETS: PersonaDocument['responseBudgets'] = {
  brief: { targetCharacters: 60, maxOutputTokens: 160 },
  normal: { targetCharacters: 240, maxOutputTokens: 600 },
  deep: { targetCharacters: 900, maxOutputTokens: 1800 },
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${path} must be an object`)
  }
  return value as Record<string, unknown>
}

function text(value: unknown, path: string, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && value.trim() === '')) {
    throw new Error(`${path} must be ${allowEmpty ? 'a string' : 'a non-empty string'}`)
  }
  const normalized = value.trim()
  if (normalized.length > 20_000) throw new Error(`${path} must not exceed 20000 characters`)
  return normalized
}

function texts(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${path} must be an array of strings`)
  return value.map((item, index) => text(item, `${path}[${index}]`))
}

function flag(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${path} must be a boolean`)
  return value
}

function positiveInteger(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error(`${path} must be a positive integer`)
  return value as number
}

function parseBudget(value: unknown, path: string): PersonaResponseBudget {
  const budget = record(value, path)
  return {
    targetCharacters: positiveInteger(budget.targetCharacters, `${path}.targetCharacters`),
    maxOutputTokens: positiveInteger(budget.maxOutputTokens, `${path}.maxOutputTokens`),
  }
}

function parseDialogs(value: unknown): PersonaReferenceDialog[] {
  if (!Array.isArray(value)) throw new Error('persona.referenceDialogs must be an array')
  if (value.length > 24) throw new Error('persona.referenceDialogs must not contain more than 24 dialogs')
  return value.map((item, index) => {
    const dialog = record(item, `persona.referenceDialogs[${index}]`)
    return {
      user: text(dialog.user, `persona.referenceDialogs[${index}].user`),
      assistant: text(dialog.assistant, `persona.referenceDialogs[${index}].assistant`),
    }
  })
}

function parseVersionOne(root: Record<string, unknown>): PersonaDocument {
  const identity = record(root.identity, 'persona.identity')
  const style = record(root.style, 'persona.style')
  const boundaries = record(root.boundaries, 'persona.boundaries')
  return {
    schemaVersion: 2,
    kind: 'mistymoon.persona',
    displayName: text(root.displayName, 'persona.displayName'),
    identity: {
      summary: text(identity.summary, 'persona.identity.summary'),
      relationship: text(identity.relationship, 'persona.identity.relationship'),
      familiarRelationship: 'Build familiarity from shared, disclosable experiences without assuming intimacy.',
      strangerRelationship: 'Be polite and measured; let familiarity grow from actual interaction.',
    },
    style: {
      tone: texts(style.tone, 'persona.style.tone'),
      instructions: 'Adapt length and detail to the request. Keep casual chat natural and let technical work be complete.',
      avoid: texts(style.avoid, 'persona.style.avoid'),
    },
    advancedInstructions: '',
    referenceDialogs: [],
    responseBudgets: structuredClone(DEFAULT_RESPONSE_BUDGETS),
    boundaries: {
      privateByDefault: flag(boundaries.privateByDefault, 'persona.boundaries.privateByDefault'),
      requireApprovalForExternalActions: flag(
        boundaries.requireApprovalForExternalActions,
        'persona.boundaries.requireApprovalForExternalActions',
      ),
    },
  }
}

/**
 * Parse an untrusted JSON value into the current persona document version.
 * Version-one documents are upgraded in memory; unknown properties are discarded.
 * @param value - Parsed JSON value from the private persona file.
 * @returns A canonical current-version persona document.
 */
export function parsePersona(value: unknown): PersonaDocument {
  const root = record(value, 'persona')
  if (root.kind !== 'mistymoon.persona') throw new Error('persona.kind must equal "mistymoon.persona"')
  if (root.schemaVersion === 1) return parseVersionOne(root)
  if (root.schemaVersion !== 2) throw new Error('persona.schemaVersion must equal 1 or 2')

  const identity = record(root.identity, 'persona.identity')
  const style = record(root.style, 'persona.style')
  const budgets = record(root.responseBudgets, 'persona.responseBudgets')
  const boundaries = record(root.boundaries, 'persona.boundaries')
  return {
    schemaVersion: 2,
    kind: 'mistymoon.persona',
    displayName: text(root.displayName, 'persona.displayName'),
    identity: {
      summary: text(identity.summary, 'persona.identity.summary'),
      relationship: text(identity.relationship, 'persona.identity.relationship'),
      familiarRelationship: text(identity.familiarRelationship, 'persona.identity.familiarRelationship'),
      strangerRelationship: text(identity.strangerRelationship, 'persona.identity.strangerRelationship'),
    },
    style: {
      tone: texts(style.tone, 'persona.style.tone'),
      instructions: text(style.instructions, 'persona.style.instructions'),
      avoid: texts(style.avoid, 'persona.style.avoid'),
    },
    advancedInstructions: text(root.advancedInstructions, 'persona.advancedInstructions', true),
    referenceDialogs: parseDialogs(root.referenceDialogs),
    responseBudgets: {
      brief: parseBudget(budgets.brief, 'persona.responseBudgets.brief'),
      normal: parseBudget(budgets.normal, 'persona.responseBudgets.normal'),
      deep: parseBudget(budgets.deep, 'persona.responseBudgets.deep'),
    },
    boundaries: {
      privateByDefault: flag(boundaries.privateByDefault, 'persona.boundaries.privateByDefault'),
      requireApprovalForExternalActions: flag(
        boundaries.requireApprovalForExternalActions,
        'persona.boundaries.requireApprovalForExternalActions',
      ),
    },
  }
}

/**
 * Load and validate a private persona document.
 * @param path - Absolute path to the user-owned JSON document.
 * @returns The canonical current-version document.
 */
export async function loadPersona(path: string): Promise<PersonaDocument> {
  const source = await readFile(path, 'utf8')
  let value: unknown
  try {
    value = JSON.parse(source)
  } catch (error) {
    throw new Error(`persona file is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  return parsePersona(value)
}

/**
 * Validate and atomically replace the private persona document.
 * @param path - Absolute path to the user-owned JSON document.
 * @param value - Candidate persona received from a trusted local settings client.
 * @returns The canonical document written to disk.
 */
export async function savePersona(path: string, value: unknown): Promise<PersonaDocument> {
  const persona = parsePersona(value)
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, `${JSON.stringify(persona, null, 2)}\n`, 'utf8')
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true })
  }
  return persona
}

/**
 * Render the exact private persona text contributed to the DSH request header.
 * @param persona - Validated canonical persona document.
 * @returns Deterministic system-prompt text.
 */
export function renderPersona(persona: PersonaDocument): string {
  const dialogs = persona.referenceDialogs.flatMap((dialog, index) => [
    `Example ${index + 1} user: ${dialog.user}`,
    `Example ${index + 1} ${persona.displayName}: ${dialog.assistant}`,
  ])
  return [
    `You are ${persona.displayName}.`,
    'Identity:',
    persona.identity.summary,
    'Relationship with the owner:',
    persona.identity.relationship,
    'Relationship with familiar people:',
    persona.identity.familiarRelationship,
    'Relationship with strangers:',
    persona.identity.strangerRelationship,
    `Communication qualities: ${persona.style.tone.join('; ')}.`,
    'Communication instructions:',
    persona.style.instructions,
    `Avoid: ${persona.style.avoid.join('; ')}.`,
    ...(persona.advancedInstructions === '' ? [] : ['Additional behavior:', persona.advancedInstructions]),
    ...(dialogs.length === 0 ? [] : ['Reference dialogs are behavioral examples, not facts or scripts:', ...dialogs]),
    'Response length guidance:',
    `Brief casual reply: about ${persona.responseBudgets.brief.targetCharacters} characters, up to ${persona.responseBudgets.brief.maxOutputTokens} tokens.`,
    `Normal reply: about ${persona.responseBudgets.normal.targetCharacters} characters, up to ${persona.responseBudgets.normal.maxOutputTokens} tokens.`,
    `Deep technical or emotionally sensitive reply: about ${persona.responseBudgets.deep.targetCharacters} characters, up to ${persona.responseBudgets.deep.maxOutputTokens} tokens.`,
    persona.boundaries.privateByDefault
      ? 'Privacy: Treat personal context as private by default.'
      : 'Privacy: Follow the owner-defined disclosure policy for personal context.',
    persona.boundaries.requireApprovalForExternalActions
      ? 'External actions: Require owner approval before acting outside this local system.'
      : 'External actions: Follow the configured automation policy and its audit requirements.',
  ].join('\n')
}
