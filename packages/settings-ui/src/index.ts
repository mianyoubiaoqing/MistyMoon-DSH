/** Local-only Host API for the MistyMoon Web settings page. */

import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-client-connection'
import type { PersonaDocument } from '@mistymoon/dsh-foundation/persona-document'
import {
  mapCharacterCardToPersona,
  parseCharacterCardPersonaMapping,
  type CharacterCardImportDraft,
  type CharacterCardPersonaMapping,
} from '@mistymoon/dsh-foundation/character-card'
import {
  decodeCharacterCardUploadBase64,
  parseCharacterCardFile,
  type CharacterCardFilePreview,
} from '@mistymoon/dsh-foundation/character-card-container'
import {
  discardPersonaDraft,
  previewPersonaDraft,
  publishPersonaDraft,
  readPersonaWorkspace,
  rollbackPersona,
  savePersonaDraft,
  type PersonaVersionSummary,
} from '@mistymoon/dsh-foundation/persona-workspace'
import {
  DEFAULT_RECALL_LIMIT,
  loadMemoryRuntimeSettings,
  saveMemoryRuntimeSettings,
} from '@mistymoon/dsh-memory/runtime-settings'
import type { CompanionMemoryArchive, MemoryCandidate, MemoryRecord } from '@mistymoon/dsh-memory'

/** Cordis plugin name. */
export const name = 'mistymoon-settings-ui'

/** Host transport required by the local settings page. */
export const inject = ['connection', 'mistymoonMemory']

/** Settings-page Host configuration. */
export interface Config {
  /** User-owned MistyMoon data directory. */
  home: string
}

/** Runtime schema for the settings-page Host plugin. */
export const Config: z<Config> = z.object({ home: z.string().required() })

/** Private settings returned only to a same-origin loopback browser. */
export interface MistyMoonSettingsSnapshot {
  /** Editable draft when present, otherwise a copy of the active persona. */
  persona: PersonaDocument
  /** Persona currently projected into new model requests. */
  activePersona: PersonaDocument
  /** Whether `persona` is an unpublished draft. */
  hasPersonaDraft: boolean
  /** Exact immersive persona preview for the unpublished draft. */
  personaPreview?: string
  /** Newest-first rollback history. */
  personaVersions: PersonaVersionSummary[]
  recallLimit: number
}

/** Owner-facing Character Card parsing and mapping preview. */
export interface MistyMoonCharacterCardPreview {
  source: CharacterCardFilePreview['source']
  draft: CharacterCardImportDraft
  mapping: CharacterCardPersonaMapping
  persona: PersonaDocument
  warnings: string[]
}

function badRequest(message: string) {
  return { ok: false as const, error: { code: 'bad-request' as const, message, details: { issues: [] } } }
}

function internalFailure() {
  return {
    ok: false as const,
    error: { code: 'internal' as const, message: 'MistyMoon could not read or save its private settings.', details: {} },
  }
}

function exactObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const actual = Object.keys(value).toSorted()
  return actual.length === keys.length && actual.every((key, index) => key === keys.toSorted()[index])
}

/**
 * Read the private settings edited by the local Web page.
 * @param home - User-owned MistyMoon data directory.
 * @returns Current persona and effective memory recall limit.
 */
export async function readMistyMoonSettings(home: string): Promise<MistyMoonSettingsSnapshot> {
  const workspace = await readPersonaWorkspace(home)
  const memory = await loadMemoryRuntimeSettings(
    join(home, 'settings', 'settings.json'),
    DEFAULT_RECALL_LIMIT,
  )
  return {
    persona: workspace.draft?.persona ?? workspace.active,
    activePersona: workspace.active,
    hasPersonaDraft: workspace.draft !== undefined,
    ...(workspace.draft === undefined ? {} : { personaPreview: await previewPersonaDraft(home) }),
    personaVersions: workspace.versions,
    recallLimit: memory.recallLimit,
  }
}

/**
 * Validate settings and save persona changes as an inert draft.
 * @param home - User-owned MistyMoon data directory.
 * @param value - Candidate settings payload.
 * @returns Canonical settings written to disk.
 */
export async function saveMistyMoonSettings(home: string, value: unknown): Promise<MistyMoonSettingsSnapshot> {
  if (!exactObject(value, ['persona', 'recallLimit'])) throw new Error('settings payload must contain persona and recallLimit')
  const settingsPath = join(home, 'settings', 'settings.json')
  await savePersonaDraft(home, value.persona)
  await saveMemoryRuntimeSettings(settingsPath, {
    schemaVersion: 1,
    recallLimit: value.recallLimit,
  })
  return readMistyMoonSettings(home)
}

/** Publish the current persona draft and return refreshed private settings. */
export async function publishMistyMoonPersona(home: string): Promise<MistyMoonSettingsSnapshot> {
  await publishPersonaDraft(home)
  return readMistyMoonSettings(home)
}

/** Discard the current persona draft and return refreshed private settings. */
export async function discardMistyMoonPersona(home: string): Promise<MistyMoonSettingsSnapshot> {
  await discardPersonaDraft(home)
  return readMistyMoonSettings(home)
}

/** Roll back to one archived persona and return refreshed private settings. */
export async function rollbackMistyMoonPersona(home: string, versionId: string): Promise<MistyMoonSettingsSnapshot> {
  await rollbackPersona(home, versionId)
  return readMistyMoonSettings(home)
}

function characterCardRequest(value: unknown): {
  fileName: string
  bytes: Buffer
  mapping: CharacterCardPersonaMapping
} {
  if (!exactObject(value, ['contentBase64', 'fileName', 'mapping'])) {
    throw new Error('Character Card request must contain fileName, contentBase64, and mapping')
  }
  if (typeof value.fileName !== 'string') throw new Error('Character Card fileName must be a string')
  return {
    fileName: value.fileName,
    bytes: decodeCharacterCardUploadBase64(value.contentBase64),
    mapping: parseCharacterCardPersonaMapping(value.mapping),
  }
}

/** Parse and map one untrusted card without writing an active or draft persona. */
export async function previewMistyMoonCharacterCard(home: string, value: unknown): Promise<MistyMoonCharacterCardPreview> {
  const request = characterCardRequest(value)
  const parsed = await parseCharacterCardFile(request.fileName, request.bytes)
  const workspace = await readPersonaWorkspace(home)
  const mapped = mapCharacterCardToPersona(parsed.draft, workspace.active, request.mapping)
  return { source: parsed.source, draft: parsed.draft, mapping: request.mapping, ...mapped }
}

/** Reparse a reviewed card and save its mapping as an inert persona draft. */
export async function applyMistyMoonCharacterCard(home: string, value: unknown): Promise<MistyMoonSettingsSnapshot> {
  const preview = await previewMistyMoonCharacterCard(home, value)
  await savePersonaDraft(home, preview.persona)
  return readMistyMoonSettings(home)
}

/**
 * Read the pending candidate queue from the process-wide memory archive.
 * @param archive - Archive shared with recall and DSH memory tools.
 * @returns Pending candidates ordered newest first.
 */
export function readMistyMoonCandidates(archive: CompanionMemoryArchive): MemoryCandidate[] {
  return archive.listCandidates()
}

/**
 * Approve one candidate from the local owner UI.
 * @param archive - Archive shared with recall and DSH memory tools.
 * @param candidateId - Candidate selected by the owner.
 * @param requestId - Browser-generated idempotency id.
 * @returns Newly confirmed memory.
 */
export async function approveMistyMoonCandidate(
  archive: CompanionMemoryArchive,
  candidateId: string,
  requestId: string,
): Promise<MemoryRecord> {
  return archive.approveCandidate({ candidateId, sourceMessageId: `settings-ui:${requestId}` })
}

/**
 * Reject one candidate from the local owner UI.
 * @param archive - Archive shared with recall and DSH memory tools.
 * @param candidateId - Candidate selected by the owner.
 * @param requestId - Browser-generated idempotency id.
 * @returns Rejected candidate retained in private audit history.
 */
export async function rejectMistyMoonCandidate(
  archive: CompanionMemoryArchive,
  candidateId: string,
  requestId: string,
): Promise<MemoryCandidate> {
  return archive.rejectCandidate({ candidateId, sourceMessageId: `settings-ui:${requestId}` })
}

function candidateDecision(value: unknown): { candidateId: string; requestId: string } | undefined {
  if (!exactObject(value, ['candidateId', 'requestId'])) return undefined
  if (typeof value.candidateId !== 'string' || value.candidateId.trim() === '') return undefined
  if (typeof value.requestId !== 'string' || value.requestId.trim() === '') return undefined
  return { candidateId: value.candidateId, requestId: value.requestId }
}

/** Mount the loopback-only RPC channel used by the MistyMoon browser bundle. */
export function apply(ctx: Context, config: Config): void {
  ctx.connection.rpc.handle('/mistymoon-settings', async (endpoint, payload) => {
    try {
      if (endpoint === 'read') {
        if (!exactObject(payload, [])) return badRequest('MistyMoon settings read expects an empty object.')
        return { ok: true, value: await readMistyMoonSettings(config.home) }
      }
      if (endpoint === 'save') {
        if (!exactObject(payload, ['settings'])) return badRequest('MistyMoon settings save expects one settings field.')
        try {
          return { ok: true, value: await saveMistyMoonSettings(config.home, payload.settings) }
        } catch (error) {
          return badRequest(error instanceof Error ? error.message : 'MistyMoon settings are invalid.')
        }
      }
      if (endpoint === 'persona-publish' || endpoint === 'persona-discard') {
        if (!exactObject(payload, [])) return badRequest(`MistyMoon ${endpoint} expects an empty object.`)
        try {
          const value = endpoint === 'persona-publish'
            ? await publishMistyMoonPersona(config.home)
            : await discardMistyMoonPersona(config.home)
          return { ok: true, value }
        } catch (error) {
          return badRequest(error instanceof Error ? error.message : `MistyMoon ${endpoint} failed.`)
        }
      }
      if (endpoint === 'persona-rollback') {
        if (!exactObject(payload, ['versionId']) || typeof payload.versionId !== 'string') {
          return badRequest('MistyMoon persona rollback expects one versionId string.')
        }
        try {
          return { ok: true, value: await rollbackMistyMoonPersona(config.home, payload.versionId) }
        } catch (error) {
          return badRequest(error instanceof Error ? error.message : 'MistyMoon persona rollback failed.')
        }
      }
      if (endpoint === 'character-card-preview' || endpoint === 'character-card-apply') {
        try {
          const value = endpoint === 'character-card-preview'
            ? await previewMistyMoonCharacterCard(config.home, payload)
            : await applyMistyMoonCharacterCard(config.home, payload)
          return { ok: true, value }
        } catch (error) {
          return badRequest(error instanceof Error ? error.message : 'MistyMoon Character Card import failed.')
        }
      }
      if (endpoint === 'candidate-list') {
        if (!exactObject(payload, [])) return badRequest('MistyMoon candidate list expects an empty object.')
        return { ok: true, value: readMistyMoonCandidates(ctx.mistymoonMemory) }
      }
      if (endpoint === 'candidate-approve' || endpoint === 'candidate-reject') {
        const decision = candidateDecision(payload)
        if (decision === undefined) {
          return badRequest('MistyMoon candidate decisions require candidateId and requestId strings.')
        }
        try {
          const value = endpoint === 'candidate-approve'
            ? await approveMistyMoonCandidate(ctx.mistymoonMemory, decision.candidateId, decision.requestId)
            : await rejectMistyMoonCandidate(ctx.mistymoonMemory, decision.candidateId, decision.requestId)
          return { ok: true, value }
        } catch (error) {
          return badRequest(error instanceof Error ? error.message : 'MistyMoon candidate decision failed.')
        }
      }
      return badRequest('Unknown MistyMoon settings operation.')
    } catch (error) {
      ctx.logger.warn(error)
      return internalFailure()
    }
  }, { authority: 'loopback' })
}
