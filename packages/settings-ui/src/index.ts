/** Local-only Host API for the MistyMoon Web settings page. */

import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-client-connection'
import type { PublishedPersonaProjection } from '@mistymoon/dsh-foundation'
import {
  mapCharacterCardToPersona,
  parseCharacterCardPersonaMapping,
} from '@mistymoon/dsh-foundation/character-card'
import {
  decodeCharacterCardUploadBase64,
  parseCharacterCardFile,
} from '@mistymoon/dsh-foundation/character-card-container'
import {
  discardPersonaDraft,
  previewPersonaDraft,
  publishPersonaDraft,
  readPersonaWorkspace,
  rollbackPersona,
  savePersonaDraft,
} from '@mistymoon/dsh-foundation/persona-workspace'
import {
  DEFAULT_RECALL_LIMIT,
  loadMemoryRuntimeSettings,
  saveMemoryRuntimeSettings,
} from '@mistymoon/dsh-memory/runtime-settings'
import type {} from '@mistymoon/dsh-memory'
import type { MemoryCandidate, MemoryGovernanceService, MemoryRecord } from '@mistymoon/dsh-memory/contracts'
import type {
  MemoryBatchGovernanceResultV1,
  MemoryManagementSnapshotV1,
  MemorySourceViewV1,
} from '@mistymoon/dsh-memory/contracts'
import type { MemoryConflictAssessmentV1 } from '@mistymoon/dsh-memory/conflict'
import { parseMemoryKind } from '@mistymoon/dsh-memory/domain'
import type {} from '@mistymoon/dsh-work-agent-dsh'
import type {
  CharacterCardPersonaMapping,
  MistyMoonCharacterCardPreview,
  MistyMoonSettingsSnapshot,
  MistyMoonWorkModelSnapshot,
} from './contracts.js'

export * from './contracts.js'

/** Cordis plugin name. */
export const name = 'mistymoon-settings-ui'

/** Host transport required by the local settings page. */
export const inject = [
  'connection',
  'mistymoonMemoryGovernance',
  'mistymoonPersonaProjection',
  'mistymoonWorkDelegation',
]

/** Settings-page Host configuration. */
export interface Config {
  /** User-owned MistyMoon data directory. */
  home: string
}

/** Runtime schema for the settings-page Host plugin. */
export const Config: z<Config> = z.object({ home: z.string().required() })

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

function allowedObject(value: unknown, allowed: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  return Object.keys(value).every(key => allowed.includes(key))
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
 * @param governance - Memory-owned loopback governance facade.
 * @returns Pending candidates ordered newest first.
 */
export function readMistyMoonCandidates(governance: MemoryGovernanceService): MemoryCandidate[] {
  return governance.listCandidates()
}

/**
 * Approve one candidate from the local owner UI.
 * @param governance - Memory-owned loopback governance facade.
 * @param candidateId - Candidate selected by the owner.
 * @param requestId - Browser-generated idempotency id.
 * @returns Newly confirmed memory.
 */
export async function approveMistyMoonCandidate(
  governance: MemoryGovernanceService,
  candidateId: string,
  requestId: string,
): Promise<MemoryRecord> {
  return governance.approveCandidate({ candidateId, sourceMessageId: `settings-ui:${requestId}` })
}

/**
 * Reject one candidate from the local owner UI.
 * @param governance - Memory-owned loopback governance facade.
 * @param candidateId - Candidate selected by the owner.
 * @param requestId - Browser-generated idempotency id.
 * @returns Rejected candidate retained in private audit history.
 */
export async function rejectMistyMoonCandidate(
  governance: MemoryGovernanceService,
  candidateId: string,
  requestId: string,
): Promise<MemoryCandidate> {
  return governance.rejectCandidate({ candidateId, sourceMessageId: `settings-ui:${requestId}` })
}

/** Parse local UI filters and query the Memory-owned management projection. */
export function readMistyMoonMemory(
  governance: MemoryGovernanceService,
  value: unknown,
): MemoryManagementSnapshotV1 {
  if (!allowedObject(value, ['candidateStatus', 'limit', 'memoryKind', 'query', 'recordStatus', 'visibility'])) {
    throw new Error('memory search contains unknown fields')
  }
  const input = value as Record<string, unknown>
  if (input.query !== undefined && typeof input.query !== 'string') throw new Error('memory query must be a string')
  const memoryKind = input.memoryKind === undefined ? undefined : parseMemoryKind(input.memoryKind)
  if (input.visibility !== undefined && input.visibility !== 'personal' && input.visibility !== 'confidential') {
    throw new Error('memory visibility filter is unsupported')
  }
  if (input.recordStatus !== undefined && input.recordStatus !== 'active'
    && input.recordStatus !== 'inactive' && input.recordStatus !== 'all') {
    throw new Error('memory record status filter is unsupported')
  }
  if (input.candidateStatus !== undefined && input.candidateStatus !== 'pending'
    && input.candidateStatus !== 'approved' && input.candidateStatus !== 'rejected'
    && input.candidateStatus !== 'superseded' && input.candidateStatus !== 'all') {
    throw new Error('memory candidate status filter is unsupported')
  }
  if (input.limit !== undefined && (!Number.isSafeInteger(input.limit) || (input.limit as number) < 1 || (input.limit as number) > 500)) {
    throw new Error('memory management limit must be from 1 through 500')
  }
  return governance.manage({
    ...(input.query === undefined ? {} : { query: input.query as string }),
    ...(memoryKind === undefined ? {} : { memoryKind }),
    ...(input.visibility === undefined ? {} : { visibility: input.visibility as 'personal' | 'confidential' }),
    ...(input.recordStatus === undefined ? {} : { recordStatus: input.recordStatus as 'active' | 'inactive' | 'all' }),
    ...(input.candidateStatus === undefined ? {} : {
      candidateStatus: input.candidateStatus as 'pending' | 'approved' | 'rejected' | 'superseded' | 'all',
    }),
    ...(input.limit === undefined ? {} : { limit: input.limit as number }),
  })
}

export function readMistyMoonMemorySource(
  governance: MemoryGovernanceService,
  value: unknown,
): MemorySourceViewV1 {
  if (!exactObject(value, ['entity', 'id'])
    || (value.entity !== 'record' && value.entity !== 'candidate')
    || typeof value.id !== 'string' || value.id.trim() === '') {
    throw new Error('memory source view requires an entity and id')
  }
  return governance.sourceView({ entity: value.entity, id: value.id })
}

export function assessMistyMoonCandidate(
  governance: MemoryGovernanceService,
  value: unknown,
): MemoryConflictAssessmentV1 {
  if (!exactObject(value, ['candidateId']) || typeof value.candidateId !== 'string' || value.candidateId.trim() === '') {
    throw new Error('memory assessment requires one candidateId')
  }
  return governance.assessCandidate({ candidateId: value.candidateId })
}

function batchDecision(value: unknown): {
  candidateId: string
  action: 'approve' | 'reject'
  resolution?: { kind: 'keep-both' } | { kind: 'supersede'; memoryId: string }
} {
  if (!allowedObject(value, ['action', 'candidateId', 'resolution'])) throw new Error('memory batch decision is invalid')
  const input = value as Record<string, unknown>
  if (typeof input.candidateId !== 'string' || input.candidateId.trim() === ''
    || (input.action !== 'approve' && input.action !== 'reject')) throw new Error('memory batch decision is invalid')
  let resolution: { kind: 'keep-both' } | { kind: 'supersede'; memoryId: string } | undefined
  if (input.resolution !== undefined) {
    if (!allowedObject(input.resolution, ['kind', 'memoryId'])) throw new Error('memory conflict resolution is invalid')
    const candidate = input.resolution as Record<string, unknown>
    if (candidate.kind === 'keep-both' && candidate.memoryId === undefined) resolution = { kind: 'keep-both' }
    else if (candidate.kind === 'supersede' && typeof candidate.memoryId === 'string' && candidate.memoryId.trim() !== '') {
      resolution = { kind: 'supersede', memoryId: candidate.memoryId }
    } else throw new Error('memory conflict resolution is invalid')
  }
  if (input.action === 'reject' && resolution !== undefined) throw new Error('rejected candidate cannot carry a resolution')
  return { candidateId: input.candidateId, action: input.action, ...(resolution === undefined ? {} : { resolution }) }
}

export async function batchMistyMoonCandidates(
  governance: MemoryGovernanceService,
  value: unknown,
): Promise<MemoryBatchGovernanceResultV1> {
  if (!exactObject(value, ['decisions', 'requestId'])
    || typeof value.requestId !== 'string' || value.requestId.trim() === ''
    || !Array.isArray(value.decisions)) throw new Error('memory batch request is invalid')
  return governance.batchDecide({ requestId: value.requestId, decisions: value.decisions.map(batchDecision) })
}

function revisionRequest(value: unknown): {
  requestId: string
  candidateIds: string[]
  content: string
  visibility: 'personal' | 'confidential'
  memoryKind: ReturnType<typeof parseMemoryKind>
} {
  if (!exactObject(value, ['candidateIds', 'content', 'memoryKind', 'requestId', 'visibility'])
    || typeof value.requestId !== 'string' || value.requestId.trim() === ''
    || !Array.isArray(value.candidateIds) || value.candidateIds.some(item => typeof item !== 'string' || item.trim() === '')
    || typeof value.content !== 'string' || value.content.trim() === ''
    || (value.visibility !== 'personal' && value.visibility !== 'confidential')) {
    throw new Error('memory candidate revision is invalid')
  }
  return {
    requestId: value.requestId,
    candidateIds: value.candidateIds as string[],
    content: value.content,
    visibility: value.visibility,
    memoryKind: parseMemoryKind(value.memoryKind),
  }
}

export async function reviseMistyMoonCandidates(
  governance: MemoryGovernanceService,
  mode: 'edit' | 'merge',
  value: unknown,
): Promise<MemoryCandidate> {
  const input = revisionRequest(value)
  const request = {
    candidateIds: input.candidateIds,
    sourceMessageId: `settings-ui:${input.requestId}`,
    content: input.content,
    visibility: input.visibility,
    memoryKind: input.memoryKind,
  }
  return mode === 'edit' ? governance.editCandidate(request) : governance.mergeCandidates(request)
}

/** Read the live DSH model catalog and the credential-free Work selection. */
export async function readMistyMoonWorkModel(ctx: Context): Promise<MistyMoonWorkModelSnapshot> {
  return {
    selection: ctx.mistymoonWorkDelegation.modelSettings(),
    options: await ctx.mistymoonWorkDelegation.modelCatalog(),
  }
}

/** Validate and save one Owner-selected DSH model reference for future Work children. */
export async function configureMistyMoonWorkModel(
  ctx: Context,
  value: unknown,
): Promise<MistyMoonWorkModelSnapshot> {
  if (!exactObject(value, ['expectedRevision', 'model', 'ownerConfirmed', 'provider'])
    || !Number.isSafeInteger(value.expectedRevision)
    || typeof value.provider !== 'string'
    || typeof value.model !== 'string'
    || typeof value.ownerConfirmed !== 'boolean') {
    throw new Error('MistyMoon Work model save expects revision, provider, model, and confirmation.')
  }
  await ctx.mistymoonWorkDelegation.configureModelRoute({
    version: 1,
    expectedRevision: value.expectedRevision as number,
    provider: value.provider,
    model: value.model,
    ownerConfirmed: value.ownerConfirmed,
  })
  return readMistyMoonWorkModel(ctx)
}

function candidateDecision(value: unknown): { candidateId: string; requestId: string } | undefined {
  if (!exactObject(value, ['candidateId', 'requestId'])) return undefined
  if (typeof value.candidateId !== 'string' || value.candidateId.trim() === '') return undefined
  if (typeof value.requestId !== 'string' || value.requestId.trim() === '') return undefined
  return { candidateId: value.candidateId, requestId: value.requestId }
}

/** Mount the loopback-only RPC channel used by the MistyMoon browser bundle. */
export function apply(ctx: Context, config: Config): void {
  const personaProjection = ctx.get('mistymoonPersonaProjection', true) as PublishedPersonaProjection
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
          if (endpoint === 'persona-publish') personaProjection.replace(value.activePersona)
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
          const value = await rollbackMistyMoonPersona(config.home, payload.versionId)
          personaProjection.replace(value.activePersona)
          return { ok: true, value }
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
        return { ok: true, value: readMistyMoonCandidates(ctx.mistymoonMemoryGovernance) }
      }
      if (endpoint === 'candidate-approve' || endpoint === 'candidate-reject') {
        const decision = candidateDecision(payload)
        if (decision === undefined) {
          return badRequest('MistyMoon candidate decisions require candidateId and requestId strings.')
        }
        try {
          const value = endpoint === 'candidate-approve'
            ? await approveMistyMoonCandidate(ctx.mistymoonMemoryGovernance, decision.candidateId, decision.requestId)
            : await rejectMistyMoonCandidate(ctx.mistymoonMemoryGovernance, decision.candidateId, decision.requestId)
          return { ok: true, value }
        } catch (error) {
          return badRequest(error instanceof Error ? error.message : 'MistyMoon candidate decision failed.')
        }
      }
      if (endpoint === 'memory-search' || endpoint === 'memory-source' || endpoint === 'memory-assess'
        || endpoint === 'memory-batch' || endpoint === 'memory-edit' || endpoint === 'memory-merge') {
        try {
          if (endpoint === 'memory-search') {
            return { ok: true, value: readMistyMoonMemory(ctx.mistymoonMemoryGovernance, payload) }
          }
          if (endpoint === 'memory-source') {
            return { ok: true, value: readMistyMoonMemorySource(ctx.mistymoonMemoryGovernance, payload) }
          }
          if (endpoint === 'memory-assess') {
            return { ok: true, value: assessMistyMoonCandidate(ctx.mistymoonMemoryGovernance, payload) }
          }
          if (endpoint === 'memory-batch') {
            return { ok: true, value: await batchMistyMoonCandidates(ctx.mistymoonMemoryGovernance, payload) }
          }
          return {
            ok: true,
            value: await reviseMistyMoonCandidates(
              ctx.mistymoonMemoryGovernance,
              endpoint === 'memory-edit' ? 'edit' : 'merge',
              payload,
            ),
          }
        } catch (error) {
          return badRequest(error instanceof Error ? error.message : 'MistyMoon memory management failed.')
        }
      }
      if (endpoint === 'work-model-read') {
        if (!exactObject(payload, [])) return badRequest('MistyMoon Work model read expects an empty object.')
        return { ok: true, value: await readMistyMoonWorkModel(ctx) }
      }
      if (endpoint === 'work-model-save') {
        try {
          return { ok: true, value: await configureMistyMoonWorkModel(ctx, payload) }
        } catch (error) {
          return badRequest(error instanceof Error ? error.message : 'MistyMoon Work model selection failed.')
        }
      }
      return badRequest('Unknown MistyMoon settings operation.')
    } catch (error) {
      ctx.logger.warn(error)
      return internalFailure()
    }
  }, { authority: 'loopback' })
}
