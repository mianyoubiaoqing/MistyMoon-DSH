/** Local-only Host API for the MistyMoon Web settings page. */

import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-client-connection'
import { loadPersona, savePersona, type PersonaDocument } from '@mistymoon/dsh-foundation/persona-document'
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
  persona: PersonaDocument
  recallLimit: number
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
  const persona = await loadPersona(join(home, 'persona', 'persona.json'))
  const memory = await loadMemoryRuntimeSettings(
    join(home, 'settings', 'settings.json'),
    DEFAULT_RECALL_LIMIT,
  )
  return { persona, recallLimit: memory.recallLimit }
}

/**
 * Validate and replace the private settings edited by the local Web page.
 * @param home - User-owned MistyMoon data directory.
 * @param value - Candidate settings payload.
 * @returns Canonical settings written to disk.
 */
export async function saveMistyMoonSettings(home: string, value: unknown): Promise<MistyMoonSettingsSnapshot> {
  if (!exactObject(value, ['persona', 'recallLimit'])) throw new Error('settings payload must contain persona and recallLimit')
  const personaPath = join(home, 'persona', 'persona.json')
  const settingsPath = join(home, 'settings', 'settings.json')
  const persona = await savePersona(personaPath, value.persona)
  const memory = await saveMemoryRuntimeSettings(settingsPath, {
    schemaVersion: 1,
    recallLimit: value.recallLimit,
  })
  return { persona, recallLimit: memory.recallLimit }
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
