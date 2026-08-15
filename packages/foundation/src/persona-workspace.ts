/** Draft, preview, publication, and rollback lifecycle for a private persona. */

import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { loadPersona, parsePersona, renderPersona, savePersona, type PersonaDocument } from './persona-document.js'

/** Persisted editable persona that cannot affect model requests before publication. */
export interface PersonaDraft {
  schemaVersion: 1
  kind: 'mistymoon.persona-draft'
  createdAt: string
  updatedAt: string
  baseFingerprint: string
  persona: PersonaDocument
}

/** Reason an active persona snapshot entered rollback history. */
export type PersonaVersionReason = 'publish' | 'rollback'

/** Persisted immutable snapshot of a formerly active persona. */
export interface PersonaVersion {
  schemaVersion: 1
  kind: 'mistymoon.persona-version'
  id: string
  createdAt: string
  reason: PersonaVersionReason
  persona: PersonaDocument
}

/** Summary safe for a local settings history list. */
export interface PersonaVersionSummary {
  id: string
  createdAt: string
  reason: PersonaVersionReason
  displayName: string
}

/** Complete owner-facing state of the private persona workspace. */
export interface PersonaWorkspace {
  active: PersonaDocument
  draft?: PersonaDraft
  versions: PersonaVersionSummary[]
}

function paths(home: string) {
  const directory = join(home, 'persona')
  return {
    active: join(directory, 'persona.json'),
    draft: join(directory, 'draft.json'),
    versions: join(directory, 'versions'),
  }
}

function fingerprint(persona: PersonaDocument): string {
  return createHash('sha256').update(JSON.stringify(persona)).digest('hex')
}

async function writeJsonAtomically(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true })
  }
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as Record<string, unknown>
}

function timestamp(value: unknown, label: string): string {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) throw new Error(`${label} must be an ISO timestamp`)
  return value
}

function parseDraft(value: unknown): PersonaDraft {
  const root = object(value, 'persona draft')
  if (root.schemaVersion !== 1 || root.kind !== 'mistymoon.persona-draft') {
    throw new Error('unsupported persona draft format')
  }
  if (typeof root.baseFingerprint !== 'string' || !/^[a-f0-9]{64}$/u.test(root.baseFingerprint)) {
    throw new Error('persona draft baseFingerprint must be a SHA-256 digest')
  }
  return {
    schemaVersion: 1,
    kind: 'mistymoon.persona-draft',
    createdAt: timestamp(root.createdAt, 'persona draft createdAt'),
    updatedAt: timestamp(root.updatedAt, 'persona draft updatedAt'),
    baseFingerprint: root.baseFingerprint,
    persona: parsePersona(root.persona),
  }
}

function validVersionId(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z_[0-9a-f-]{36}$/u.test(value)
}

function parseVersion(value: unknown, expectedId?: string): PersonaVersion {
  const root = object(value, 'persona version')
  if (root.schemaVersion !== 1 || root.kind !== 'mistymoon.persona-version') {
    throw new Error('unsupported persona version format')
  }
  if (typeof root.id !== 'string' || !validVersionId(root.id) || (expectedId !== undefined && root.id !== expectedId)) {
    throw new Error('persona version id is invalid')
  }
  if (root.reason !== 'publish' && root.reason !== 'rollback') throw new Error('persona version reason is invalid')
  return {
    schemaVersion: 1,
    kind: 'mistymoon.persona-version',
    id: root.id,
    createdAt: timestamp(root.createdAt, 'persona version createdAt'),
    reason: root.reason,
    persona: parsePersona(root.persona),
  }
}

async function readOptionalDraft(path: string): Promise<PersonaDraft | undefined> {
  try {
    return parseDraft(JSON.parse(await readFile(path, 'utf8')) as unknown)
  } catch (error) {
    if (error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

async function archivePersona(home: string, persona: PersonaDocument, reason: PersonaVersionReason): Promise<PersonaVersion> {
  const createdAt = new Date().toISOString()
  const id = `${createdAt.replaceAll(':', '-')}_${randomUUID()}`
  const version: PersonaVersion = { schemaVersion: 1, kind: 'mistymoon.persona-version', id, createdAt, reason, persona }
  await writeJsonAtomically(join(paths(home).versions, `${id}.json`), version)
  return version
}

/** Read active, draft, and rollback history without exposing data outside the private home. */
export async function readPersonaWorkspace(home: string): Promise<PersonaWorkspace> {
  const location = paths(home)
  const active = await loadPersona(location.active)
  const draft = await readOptionalDraft(location.draft)
  let names: string[]
  try {
    names = await readdir(location.versions)
  } catch (error) {
    if (error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT') names = []
    else throw error
  }
  const versions = await Promise.all(names.filter(name => name.endsWith('.json')).map(async (name) => {
    const id = name.slice(0, -5)
    if (!validVersionId(id)) throw new Error(`invalid persona version filename ${JSON.stringify(name)}`)
    const version = parseVersion(JSON.parse(await readFile(join(location.versions, name), 'utf8')) as unknown, id)
    return { id: version.id, createdAt: version.createdAt, reason: version.reason, displayName: version.persona.displayName }
  }))
  versions.sort((left, right) => right.createdAt.localeCompare(left.createdAt))
  return draft === undefined ? { active, versions } : { active, draft, versions }
}

/** Validate and atomically save an inert persona draft. */
export async function savePersonaDraft(home: string, value: unknown): Promise<PersonaDraft> {
  const location = paths(home)
  const active = await loadPersona(location.active)
  const existing = await readOptionalDraft(location.draft)
  const now = new Date().toISOString()
  const draft: PersonaDraft = {
    schemaVersion: 1,
    kind: 'mistymoon.persona-draft',
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    baseFingerprint: existing?.baseFingerprint ?? fingerprint(active),
    persona: parsePersona(value),
  }
  await writeJsonAtomically(location.draft, draft)
  return draft
}

/** Render the current draft exactly as immersive RP would see it, without publishing it. */
export async function previewPersonaDraft(home: string): Promise<string> {
  const draft = await readOptionalDraft(paths(home).draft)
  if (draft === undefined) throw new Error('no persona draft exists')
  return renderPersona(draft.persona)
}

/** Publish the draft only if its active base has not changed since editing began. */
export async function publishPersonaDraft(home: string): Promise<PersonaDocument> {
  const location = paths(home)
  const active = await loadPersona(location.active)
  const draft = await readOptionalDraft(location.draft)
  if (draft === undefined) throw new Error('no persona draft exists')
  if (fingerprint(active) !== draft.baseFingerprint) {
    throw new Error('active persona changed after this draft was created; discard or recreate the draft')
  }
  await archivePersona(home, active, 'publish')
  const published = await savePersona(location.active, draft.persona)
  await rm(location.draft, { force: true })
  return published
}

/** Remove an inert draft without changing the active persona. */
export async function discardPersonaDraft(home: string): Promise<void> {
  await rm(paths(home).draft, { force: true })
}

/** Restore an archived persona after preserving the current active version. */
export async function rollbackPersona(home: string, versionId: string): Promise<PersonaDocument> {
  if (!validVersionId(versionId)) throw new Error('persona version id is invalid')
  const location = paths(home)
  if (await readOptionalDraft(location.draft) !== undefined) throw new Error('discard the current persona draft before rollback')
  const version = parseVersion(
    JSON.parse(await readFile(join(location.versions, `${versionId}.json`), 'utf8')) as unknown,
    versionId,
  )
  const active = await loadPersona(location.active)
  await archivePersona(home, active, 'rollback')
  return savePersona(location.active, version.persona)
}
