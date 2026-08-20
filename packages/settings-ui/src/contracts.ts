import type { PersonaDocument } from '@mistymoon/dsh-foundation/persona-document'
import type {
  CharacterCardImportDraft,
  CharacterCardPersonaMapping,
} from '@mistymoon/dsh-foundation/character-card'
import type { CharacterCardFilePreview } from '@mistymoon/dsh-foundation/character-card-container'
import type { PersonaVersionSummary } from '@mistymoon/dsh-foundation/persona-workspace'
import type {
  MemoryBatchDecisionV1,
  MemoryBatchGovernanceResultV1,
  MemoryCandidate,
  MemoryManagementSnapshotV1,
  MemorySourceViewV1,
} from '@mistymoon/dsh-memory/contracts'
import type { MemoryConflictAssessmentV1 } from '@mistymoon/dsh-memory/conflict'
import type {
  WorkModelCatalogEntryV1,
  WorkModelRouteSettingsV1,
} from '@mistymoon/dsh-work-agent-dsh/model-route-settings'

/** Shared local transport snapshot used by the Host and browser settings faces. */
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

/** Credential-free Work model selector state projected from the live DSH registry. */
export interface MistyMoonWorkModelSnapshot {
  selection: WorkModelRouteSettingsV1
  options: readonly WorkModelCatalogEntryV1[]
}

export type {
  CharacterCardPersonaMapping,
  MemoryCandidate,
  MemoryBatchDecisionV1,
  MemoryBatchGovernanceResultV1,
  MemoryConflictAssessmentV1,
  MemoryManagementSnapshotV1,
  MemorySourceViewV1,
  WorkModelCatalogEntryV1,
  WorkModelRouteSettingsV1,
}
