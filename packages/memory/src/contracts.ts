/** Owner-governed visibility retained with every memory. */
export type MemoryVisibility = 'personal' | 'confidential'

/** Current append-only companion memory record. */
export interface MemoryRecord {
  schemaVersion: 1
  id: string
  createdAt: string
  content: string
  visibility: MemoryVisibility
  sourceMessageId: string
  sourceCandidateId?: string
  supersedesMemoryId?: string
  status: 'confirmed' | 'forgotten' | 'superseded'
}

/** Owner-reviewable memory that is never recalled before approval. */
export interface MemoryCandidate {
  schemaVersion: 1
  event: 'candidate'
  id: string
  createdAt: string
  content: string
  visibility: MemoryVisibility
  sourceMessageId: string
  status: 'pending' | 'approved' | 'rejected'
}

/** Input for proposing a memory without activating it. */
export interface MemoryCandidateProposal {
  sourceMessageId: string
  content: string
  visibility: MemoryVisibility
}

/** Input for resolving one pending candidate. */
export interface MemoryCandidateDecision {
  candidateId: string
  sourceMessageId: string
}

/** Query over the candidate review queue. */
export interface MemoryCandidateList {
  includeResolved?: boolean
  limit?: number
}

/** Input for retiring one memory without deleting its audit history. */
export interface MemoryForget {
  memoryId: string
  sourceMessageId: string
}

/** Input for replacing one active memory with a corrected value. */
export interface MemoryReplace {
  memoryId: string
  sourceMessageId: string
  content: string
}

/** Trusted import input produced by an explicit migration adapter. */
export interface ConfirmedMemoryImport {
  sourceMessageId: string
  content: string
  createdAt: string
  visibility: MemoryVisibility
}

/** Whether a confirmed import appended a record or matched an earlier source. */
export interface ConfirmedMemoryImportResult {
  memory: MemoryRecord
  imported: boolean
}

/** Query over the current archive view. */
export interface MemoryList {
  includeInactive?: boolean
  limit?: number
}

/** Input message that may carry an explicit remember request. */
export interface ExplicitMemoryObservation {
  sourceMessageId: string
  text: string
}

/** Query over confirmed memories in this private archive. */
export interface MemoryRecall {
  query: string
  limit?: number
}

/** Small interface hiding parsing, deduplication, ranking, and JSONL durability. */
export interface CompanionMemoryArchive {
  /** Return content-free storage health for local diagnostics and maintenance planning. */
  inspection(): ArchiveInspection
  /** Stop accepting commits and wait for already-started commits up to the configured bound. */
  dispose(): Promise<void>
  /** Persist an explicit remember request, or return undefined for an ordinary message. */
  observeExplicit(input: ExplicitMemoryObservation): Promise<MemoryRecord | undefined>
  /** Return confirmed memories ranked for the supplied query. */
  recall(input: MemoryRecall): MemoryRecord[]
  /** List recent memories, optionally including retired records. */
  list(input?: MemoryList): MemoryRecord[]
  /** Retire one memory while retaining its append-only audit history. */
  forget(input: MemoryForget): Promise<MemoryRecord>
  /** Append a corrected memory and retire the prior value atomically. */
  replace(input: MemoryReplace): Promise<MemoryRecord>
  /** Append one validated migration record, idempotently by source id. */
  importConfirmed(input: ConfirmedMemoryImport): Promise<ConfirmedMemoryImportResult>
  /** Propose a memory that remains inactive until explicit owner approval. */
  propose(input: MemoryCandidateProposal): Promise<MemoryCandidate>
  /** List pending review items, optionally including resolved audit history. */
  listCandidates(input?: MemoryCandidateList): MemoryCandidate[]
  /** Promote one pending candidate into confirmed memory. */
  approveCandidate(input: MemoryCandidateDecision): Promise<MemoryRecord>
  /** Reject one pending candidate without making it recallable. */
  rejectCandidate(input: MemoryCandidateDecision): Promise<MemoryCandidate>
}
import type { ArchiveInspection } from './storage/index.js'
