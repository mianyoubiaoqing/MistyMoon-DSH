import type { ArchiveInspection } from './storage/index.js'
import type {
  MemoryAccessContextV1,
  MemoryKind,
  MemoryScopeV1,
} from './domain.js'

/** Owner-governed visibility retained with every memory. */
export type MemoryVisibility = 'personal' | 'confidential'

interface ScopedMemoryFields {
  schemaVersion: 2
  id: string
  ownerId: string
  scope: MemoryScopeV1
  observationId: string
  memoryKind: MemoryKind
  createdAt: string
  recordedAt: string
  validFrom?: string
  validTo?: string
  content: string
  visibility: MemoryVisibility
  sourceMessageId: string
}

/** Current append-only scoped companion memory record. */
export interface MemoryRecord extends ScopedMemoryFields {
  sourceCandidateId?: string
  supersedesMemoryId?: string
  status: 'confirmed' | 'forgotten' | 'superseded'
}

/** Owner-reviewable scoped memory that is never recalled before approval. */
export interface MemoryCandidate extends ScopedMemoryFields {
  event: 'candidate'
  status: 'pending' | 'approved' | 'rejected'
}

interface TrustedMemoryRequest {
  /** Host-constructed facts; never accept these values from model tool arguments. */
  context: MemoryAccessContextV1
}

/** Input for proposing a memory without activating it. */
export interface MemoryCandidateProposal extends TrustedMemoryRequest {
  sourceMessageId: string
  content: string
  visibility: MemoryVisibility
  memoryKind: MemoryKind
  recordedAt?: string
  validFrom?: string
  validTo?: string
}

/** Input for resolving one pending candidate. */
export interface MemoryCandidateDecision extends TrustedMemoryRequest {
  candidateId: string
  sourceMessageId: string
}

/** Query over the candidate review queue in one exact Owner/scope. */
export interface MemoryCandidateList extends TrustedMemoryRequest {
  includeResolved?: boolean
  limit?: number
}

/** Input for retiring one memory without deleting its audit history. */
export interface MemoryForget extends TrustedMemoryRequest {
  memoryId: string
  sourceMessageId: string
}

/** Input for replacing one active memory with a corrected value. */
export interface MemoryReplace extends TrustedMemoryRequest {
  memoryId: string
  sourceMessageId: string
  content: string
  memoryKind?: MemoryKind
  recordedAt?: string
  validFrom?: string
  validTo?: string
}

/** Trusted import input produced by an explicit migration adapter. */
export interface ConfirmedMemoryImport extends TrustedMemoryRequest {
  sourceMessageId: string
  content: string
  createdAt: string
  visibility: MemoryVisibility
  memoryKind: MemoryKind
  validFrom?: string
  validTo?: string
}

/** Whether a confirmed import appended a record or matched an earlier source. */
export interface ConfirmedMemoryImportResult {
  memory: MemoryRecord
  imported: boolean
}

/** Query over the current archive view in one exact Owner/scope. */
export interface MemoryList extends TrustedMemoryRequest {
  includeInactive?: boolean
  limit?: number
}

/** Input message that may carry an explicit remember request. */
export interface ExplicitMemoryObservation extends TrustedMemoryRequest {
  sourceMessageId: string
  text: string
  memoryKind: MemoryKind
}

/** Query over confirmed memories in one exact Owner/scope. */
export interface MemoryRecall extends TrustedMemoryRequest {
  query: string
  limit?: number
  at?: string
}

/** Small interface hiding parsing, scoped governance, ranking, and JSONL durability. */
export interface CompanionMemoryArchive {
  inspection(): ArchiveInspection
  dispose(): Promise<void>
  observeExplicit(input: ExplicitMemoryObservation): Promise<MemoryRecord | undefined>
  recall(input: MemoryRecall): MemoryRecord[]
  list(input: MemoryList): MemoryRecord[]
  forget(input: MemoryForget): Promise<MemoryRecord>
  replace(input: MemoryReplace): Promise<MemoryRecord>
  importConfirmed(input: ConfirmedMemoryImport): Promise<ConfirmedMemoryImportResult>
  propose(input: MemoryCandidateProposal): Promise<MemoryCandidate>
  listCandidates(input: MemoryCandidateList): MemoryCandidate[]
  approveCandidate(input: MemoryCandidateDecision): Promise<MemoryRecord>
  rejectCandidate(input: MemoryCandidateDecision): Promise<MemoryCandidate>
}

/** Context-free facade exposed only to the authenticated loopback settings transport. */
export interface MemoryGovernanceService {
  listCandidates(input?: Omit<MemoryCandidateList, 'context'>): MemoryCandidate[]
  approveCandidate(input: Omit<MemoryCandidateDecision, 'context'>): Promise<MemoryRecord>
  rejectCandidate(input: Omit<MemoryCandidateDecision, 'context'>): Promise<MemoryCandidate>
}
