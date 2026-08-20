/** Browser half of the local MistyMoon settings plugin. */

import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {
  CharacterCardPersonaMapping,
  MemoryBatchDecisionV1,
  MemoryBatchGovernanceResultV1,
  MemoryCandidate,
  MemoryConflictAssessmentV1,
  MemoryManagementSnapshotV1,
  MemorySourceViewV1,
  MistyMoonCharacterCardPreview,
  MistyMoonSettingsSnapshot,
  MistyMoonWorkModelSnapshot,
} from '../contracts.js'
import { MistyMoonSettingsTab, type MistyMoonSettingsTabInjected } from './MistyMoonSettingsTab.js'
import { MistyMoonMemoryTab, type MistyMoonMemoryTabInjected, type MemorySearchFilters } from './MistyMoonMemoryTab.js'
import { en, zh, type MistyMoonSettingsLocaleKey } from './locales.js'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Local-only MistyMoon settings copy. */
    'settings.mistymoon': MistyMoonSettingsLocaleKey
  }
}

/** Required browser services. */
export const inject = ['slots', 'locale', 'connection']

const NS = 'settings.mistymoon'
const STYLE_ID = '@mistymoon/dsh/settings-ui'

const CSS = `
.mistymoon-settings{width:100%;max-width:760px;color:var(--dsw-alias-label-primary);display:flex;flex-direction:column;gap:16px}
.mistymoon-settings header h3,.mistymoon-settings header p,.mistymoon-status,.mistymoon-error p,.mistymoon-validation,.mistymoon-success{margin:0}
.mistymoon-settings header{display:flex;flex-direction:column;gap:6px}.mistymoon-settings header p,.mistymoon-settings small,.mistymoon-status{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:20px}
.mistymoon-settings fieldset{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:10px;padding:14px;display:flex;flex-direction:column;gap:12px}
.mistymoon-settings legend{padding:0 6px;font-size:14px;font-weight:600}.mistymoon-settings label{display:flex;flex-direction:column;gap:6px;font-size:13px;font-weight:500}
.mistymoon-settings input,.mistymoon-settings textarea{box-sizing:border-box;width:100%;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;border-radius:8px;padding:8px 10px;outline:none}
.mistymoon-settings input:focus-visible,.mistymoon-settings textarea:focus-visible{border-color:var(--dsw-alias-state-business-primary);box-shadow:0 0 0 2px color-mix(in srgb,var(--dsw-alias-state-business-primary) 18%,transparent)}
.mistymoon-settings textarea{resize:vertical;line-height:20px}.mistymoon-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.mistymoon-settings .mistymoon-check{flex-direction:row;align-items:center;font-weight:400}.mistymoon-check input{width:16px;height:16px;margin:0}
.mistymoon-actions{display:flex;flex-wrap:wrap;gap:8px;justify-content:flex-end}.mistymoon-actions button,.mistymoon-error button{border:0;background:var(--dsw-alias-state-business-primary);color:#fff;font:inherit;border-radius:8px;padding:8px 16px;cursor:pointer}.mistymoon-actions button:disabled{opacity:.5;cursor:not-allowed}.mistymoon-actions .mistymoon-secondary{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l2)}
.mistymoon-preview{white-space:pre-wrap;max-height:240px;overflow:auto;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:10px;font-size:12px;line-height:18px}.mistymoon-version{display:flex;align-items:center;justify-content:space-between;gap:10px}.mistymoon-version button{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border-radius:7px;padding:5px 10px;cursor:pointer}
.mistymoon-import{display:flex;flex-direction:column;gap:10px}.mistymoon-import-meta{display:flex;flex-wrap:wrap;gap:8px}.mistymoon-import-meta span{background:var(--dsw-alias-bg-layer-1);border-radius:999px;padding:3px 8px;font-size:12px}.mistymoon-import-warnings{margin:0;padding-left:20px;color:var(--dsw-alias-state-warning-primary);font-size:13px}.mistymoon-settings select{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;border-radius:8px;padding:8px 10px}
.mistymoon-review{display:flex;flex-direction:column;gap:10px;border-top:1px solid var(--dsw-alias-border-l2);padding-top:12px}.mistymoon-review h4,.mistymoon-review p{margin:0}.mistymoon-review>div>p,.mistymoon-empty{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:20px}.mistymoon-candidate{display:flex;flex-direction:column;gap:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);border-radius:8px;padding:12px}.mistymoon-candidate>p{font-size:14px;line-height:21px}.mistymoon-candidate-actions{display:flex;gap:8px;justify-content:flex-end}.mistymoon-candidate-actions button{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:inherit;border-radius:7px;padding:6px 12px;cursor:pointer}.mistymoon-candidate-actions button:first-child{border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-state-business-primary)}.mistymoon-candidate-actions button:disabled{opacity:.5;cursor:not-allowed}
.mistymoon-validation,.mistymoon-error{color:var(--dsw-alias-state-error-primary);font-size:13px}.mistymoon-success{color:var(--dsw-alias-state-success-primary);font-size:13px}.mistymoon-error{display:flex;align-items:center;gap:10px}
.mistymoon-memory-manager article+article{margin-top:8px}.mistymoon-memory-manager pre{overflow-wrap:anywhere}.mistymoon-memory-filters>input{margin-bottom:4px}
@media (max-width:680px){.mistymoon-grid{grid-template-columns:minmax(0,1fr)}}`

function snapshot(value: unknown): MistyMoonSettingsSnapshot {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('invalid MistyMoon settings response')
  const record = value as Record<string, unknown>
  if (typeof record.persona !== 'object' || record.persona === null || !Number.isSafeInteger(record.recallLimit)) {
    throw new Error('invalid MistyMoon settings response')
  }
  return record as unknown as MistyMoonSettingsSnapshot
}

function candidateList(value: unknown): MemoryCandidate[] {
  if (!Array.isArray(value)) throw new Error('invalid MistyMoon candidate response')
  for (const item of value) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw new Error('invalid MistyMoon candidate response')
    }
    const record = item as Record<string, unknown>
    if (record.event !== 'candidate'
      || typeof record.id !== 'string'
      || typeof record.content !== 'string'
      || (record.visibility !== 'personal' && record.visibility !== 'confidential')
      || record.status !== 'pending') {
      throw new Error('invalid MistyMoon candidate response')
    }
  }
  return value as MemoryCandidate[]
}

function characterCardPreview(value: unknown): MistyMoonCharacterCardPreview {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('invalid Character Card preview')
  const record = value as Record<string, unknown>
  if (typeof record.source !== 'object' || record.source === null
    || typeof record.draft !== 'object' || record.draft === null
    || typeof record.mapping !== 'object' || record.mapping === null
    || typeof record.persona !== 'object' || record.persona === null
    || !Array.isArray(record.warnings) || record.warnings.some(item => typeof item !== 'string')) {
    throw new Error('invalid Character Card preview')
  }
  return value as MistyMoonCharacterCardPreview
}

function workModelSnapshot(value: unknown): MistyMoonWorkModelSnapshot {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('invalid MistyMoon Work model response')
  }
  const record = value as Record<string, unknown>
  if (typeof record.selection !== 'object' || record.selection === null || !Array.isArray(record.options)) {
    throw new Error('invalid MistyMoon Work model response')
  }
  return value as unknown as MistyMoonWorkModelSnapshot
}

function managementSnapshot(value: unknown): MemoryManagementSnapshotV1 {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('invalid memory management response')
  const record = value as Record<string, unknown>
  if (record.schemaVersion !== 1 || !Array.isArray(record.records)
    || !Array.isArray(record.candidates) || !Array.isArray(record.audit)) throw new Error('invalid memory management response')
  return value as MemoryManagementSnapshotV1
}

function sourceSnapshot(value: unknown): MemorySourceViewV1 {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('invalid memory source response')
  const record = value as Record<string, unknown>
  if (record.schemaVersion !== 1 || (record.entity !== 'record' && record.entity !== 'candidate')
    || typeof record.id !== 'string' || typeof record.observation !== 'object' || record.observation === null) {
    throw new Error('invalid memory source response')
  }
  return value as unknown as MemorySourceViewV1
}

function assessmentSnapshot(value: unknown): MemoryConflictAssessmentV1 {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('invalid memory assessment response')
  const record = value as Record<string, unknown>
  if (record.schemaVersion !== 1 || typeof record.candidateId !== 'string' || !Array.isArray(record.relationships)) {
    throw new Error('invalid memory assessment response')
  }
  return value as unknown as MemoryConflictAssessmentV1
}

function batchSnapshot(value: unknown): MemoryBatchGovernanceResultV1 {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('invalid memory batch response')
  const record = value as Record<string, unknown>
  if (record.schemaVersion !== 1 || !Array.isArray(record.results)) throw new Error('invalid memory batch response')
  return value as MemoryBatchGovernanceResultV1
}

/** Register the MistyMoon tab in the Plugins settings section. */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'mistymoon-settings-ui: dictionaries')
  ctx.effect(() => {
    const style = document.createElement('style')
    style.dataset.pluginCss = STYLE_ID
    style.textContent = CSS
    document.head.appendChild(style)
    return () => { style.remove() }
  }, 'mistymoon-settings-ui: styles')

  // The package emits Host and Client faces from one project; declaration
  // merging therefore exposes the Host connection type here even though this
  // entry only runs in the browser module graph.
  const connection = ctx.get('connection') as unknown as ConnectionHandle
  const call = async (endpoint: 'read' | 'save' | 'persona-publish' | 'persona-discard' | 'persona-rollback', payload: unknown): Promise<MistyMoonSettingsSnapshot> => {
    const result = await connection.rpc.call('/mistymoon-settings', endpoint, payload)
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
    return snapshot(result.value)
  }
  const callCandidates = async (): Promise<MemoryCandidate[]> => {
    const result = await connection.rpc.call('/mistymoon-settings', 'candidate-list', {})
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
    return candidateList(result.value)
  }
  const decideCandidate = async (endpoint: 'candidate-approve' | 'candidate-reject', candidateId: string): Promise<void> => {
    const result = await connection.rpc.call('/mistymoon-settings', endpoint, {
      candidateId,
      requestId: crypto.randomUUID(),
    })
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
  }
  const readWorkModel = async (): Promise<MistyMoonWorkModelSnapshot> => {
    const result = await connection.rpc.call('/mistymoon-settings', 'work-model-read', {})
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
    return workModelSnapshot(result.value)
  }
  const saveWorkModel = async (input: {
    expectedRevision: number
    provider: string
    model: string
    ownerConfirmed: boolean
  }): Promise<MistyMoonWorkModelSnapshot> => {
    const result = await connection.rpc.call('/mistymoon-settings', 'work-model-save', input)
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
    return workModelSnapshot(result.value)
  }
  const cardPayload = (fileName: string, contentBase64: string, mapping: CharacterCardPersonaMapping) => ({
    fileName, contentBase64, mapping,
  })
  const previewCharacterCard = async (
    fileName: string,
    contentBase64: string,
    mapping: CharacterCardPersonaMapping,
  ): Promise<MistyMoonCharacterCardPreview> => {
    const result = await connection.rpc.call(
      '/mistymoon-settings',
      'character-card-preview',
      cardPayload(fileName, contentBase64, mapping),
    )
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
    return characterCardPreview(result.value)
  }
  const applyCharacterCard = async (
    fileName: string,
    contentBase64: string,
    mapping: CharacterCardPersonaMapping,
  ): Promise<MistyMoonSettingsSnapshot> => {
    const result = await connection.rpc.call(
      '/mistymoon-settings',
      'character-card-apply',
      cardPayload(fileName, contentBase64, mapping),
    )
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
    return snapshot(result.value)
  }
  const injected: MistyMoonSettingsTabInjected = {
    read: () => call('read', {}),
    save: settings => call('save', { settings: { persona: settings.persona, recallLimit: settings.recallLimit } }),
    publishPersona: () => call('persona-publish', {}),
    discardPersona: () => call('persona-discard', {}),
    rollbackPersona: versionId => call('persona-rollback', { versionId }),
    previewCharacterCard,
    applyCharacterCard,
    listCandidates: callCandidates,
    readWorkModel,
    saveWorkModel,
    approveCandidate: candidateId => decideCandidate('candidate-approve', candidateId),
    rejectCandidate: candidateId => decideCandidate('candidate-reject', candidateId),
  }
  const memoryRpc = async (endpoint: string, payload: unknown): Promise<unknown> => {
    const result = await connection.rpc.call('/mistymoon-settings', endpoint, payload)
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
    return result.value
  }
  const memoryInjected: MistyMoonMemoryTabInjected = {
    search: async (filters: MemorySearchFilters) => managementSnapshot(await memoryRpc('memory-search', filters)),
    source: async (entity, id) => sourceSnapshot(await memoryRpc('memory-source', { entity, id })),
    assess: async candidateId => assessmentSnapshot(await memoryRpc('memory-assess', { candidateId })),
    batch: async (decisions: MemoryBatchDecisionV1[]) => batchSnapshot(await memoryRpc('memory-batch', {
      requestId: crypto.randomUUID(),
      decisions,
    })),
    edit: async (candidate, content) => {
      await memoryRpc('memory-edit', {
        candidateIds: [candidate.id],
        requestId: crypto.randomUUID(),
        content,
        visibility: candidate.visibility,
        memoryKind: candidate.memoryKind,
      })
    },
    merge: async (candidateIds, content, memoryKind, visibility) => {
      await memoryRpc('memory-merge', {
        candidateIds,
        requestId: crypto.randomUUID(),
        content,
        visibility,
        memoryKind,
      })
    },
  }
  const t = ctx.locale.bind(NS)
  ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
    name: 'settings.plugins.tab',
    id: 'mistymoon',
    order: 5,
    label: () => t('tab'),
    locale: NS,
    inject: () => injected,
  }, MistyMoonSettingsTab))
  ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
    name: 'settings.plugins.tab',
    id: 'mistymoon-memory',
    order: 6,
    label: () => t('memoryTab'),
    locale: NS,
    inject: () => memoryInjected,
  }, MistyMoonMemoryTab))
}

export type { MistyMoonSettingsTabInjected, MistyMoonSettingsTabProps } from './MistyMoonSettingsTab.js'
export type { MistyMoonMemoryTabInjected, MistyMoonMemoryTabProps } from './MistyMoonMemoryTab.js'
export type { MistyMoonSettingsLocaleKey } from './locales.js'
