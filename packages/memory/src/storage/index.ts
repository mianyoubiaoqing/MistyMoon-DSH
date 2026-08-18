import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import { lock as acquireProperLock } from 'proper-lockfile'
import type { MemoryCandidate, MemoryRecord } from '../contracts.js'

export interface MemoryForgottenEvent {
  schemaVersion: 1
  event: 'forgotten'
  id: string
  createdAt: string
  memoryId: string
  sourceMessageId: string
}

export interface MemoryCandidateResolutionEvent {
  schemaVersion: 1
  event: 'candidate-resolution'
  id: string
  createdAt: string
  candidateId: string
  decision: 'approved' | 'rejected'
  sourceMessageId: string
  memoryId?: string
}

export type MemoryDomainEvent = MemoryRecord | MemoryCandidate | MemoryForgottenEvent | MemoryCandidateResolutionEvent

export type ArchiveIssueCode =
  | 'trailing-partial-transaction'
  | 'interior-invalid-json'
  | 'unsupported-archive-version'
  | 'invalid-header'
  | 'invalid-transaction'
  | 'digest-mismatch'
  | 'broken-previous-digest'
  | 'duplicate-id'
  | 'duplicate-source'
  | 'invalid-state-transition'
  | 'unknown-required-event'
  | 'archive-too-large'
  | 'transaction-too-large'
  | 'checkpoint-mismatch'

export interface ArchiveIssue {
  code: ArchiveIssueCode
  line: number
  offset: number
}

export interface ArchiveInspection {
  state: 'ready' | 'migration-required' | 'quarantined'
  format: 'v1' | 'v2' | 'unknown'
  sizeBytes: number
  transactionCount: number
  eventCount: number
  lastValidOffset: number
  digest: string
  issues: ArchiveIssue[]
}

export interface SourceUse {
  kind: 'memory' | 'candidate' | 'forget' | 'replace' | 'approve' | 'reject'
  transactionId: string
  memoryId?: string
  candidateId?: string
  targetMemoryId?: string
  content?: string
  visibility?: 'personal' | 'confidential'
  createdAt?: string
}

export interface FoldedMemoryState {
  records: MemoryRecord[]
  candidates: MemoryCandidate[]
  byId: Map<string, MemoryRecord>
  candidateById: Map<string, MemoryCandidate>
  sources: Map<string, SourceUse>
}

interface ArchiveHeaderV2 {
  kind: 'mistymoon-memory-archive'
  schemaVersion: 2
  archiveId: string
  createdAt: string
  integrity: {
    algorithm: 'sha256'
    canonicalization: 'sorted-json-v1'
  }
}

interface ArchiveTransactionV2 {
  kind: 'transaction'
  schemaVersion: 2
  id: string
  committedAt: string
  previousDigest: string
  events: MemoryDomainEvent[]
  digest: string
}

interface ArchiveCheckpointV1 {
  schemaVersion: 1
  archiveDigest: string
  archiveSize: number
  transactionCount: number
  eventCount: number
  lastTransactionDigest: string
}

export interface ParsedArchive {
  inspection: ArchiveInspection
  state?: FoldedMemoryState
  header?: ArchiveHeaderV2
  lastDigest?: string
}

export interface MemoryArchiveStorageOptions {
  path: string
  now?: () => Date
  createTransactionId?: () => string
  leaseTimeoutMs?: number
  leaseStaleMs?: number
  maxArchiveBytes?: number
  maxTransactionBytes?: number
  disposeTimeoutMs?: number
  /** @internal Deterministic lease seam for storage fault tests. */
  leaseAdapter?: ArchiveLeaseAdapter
  /** @internal Deterministic append/fsync seam for storage fault tests. */
  commitWriter?: ArchiveCommitWriter
  /** @internal Deterministic checkpoint seam for storage fault tests. */
  checkpointWriter?: ArchiveCheckpointWriter
}

/** A held archive lease that can report asynchronous compromise before publication. */
export interface ArchiveLease {
  assertHeld(): void
}

/** Options required from the production file-lock implementation. */
export interface ArchiveLeaseAcquireOptions {
  stale: number
  update: number
  retries: { retries: number, minTimeout: number, maxTimeout: number, randomize: boolean }
  realpath: false
  onCompromised: (error: Error) => void
}

/** @internal Injectable acquire primitive used to verify timeout, compromise, and release failures. */
export type ArchiveLeaseAcquire = (
  path: string,
  options: ArchiveLeaseAcquireOptions,
) => Promise<() => Promise<void>>

/** Exclusive cross-process lease boundary. */
export interface ArchiveLeaseAdapter {
  withExclusiveLease<T>(
    path: string,
    timeoutMs: number,
    action: (lease: ArchiveLease) => Promise<T>,
    staleMs?: number,
  ): Promise<T>
}

/** Append one complete transaction and flush its file handle before resolving. */
export interface ArchiveCommitWriter {
  appendAndFlush(path: string, bytes: Buffer): Promise<void>
}

/** Publish the adjacent durability checkpoint for one verified archive generation. */
export interface ArchiveCheckpointWriter {
  write(path: string, parsed: ParsedArchive): Promise<void>
}

export interface ArchiveMutation<T> {
  events: MemoryDomainEvent[]
  result: T
}

export class MemoryArchiveError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'MEMORY_ARCHIVE_MIGRATION_REQUIRED'
      | 'MEMORY_ARCHIVE_QUARANTINED'
      | 'MEMORY_LEASE_TIMEOUT'
      | 'MEMORY_LEASE_COMPROMISED'
      | 'MEMORY_LEASE_RELEASE_FAILED'
      | 'MEMORY_SOURCE_CONFLICT'
      | 'MEMORY_ARCHIVE_DISPOSED'
      | 'MEMORY_DISPOSE_TIMEOUT',
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'MemoryArchiveError'
  }
}

/**
 * Build the production lease adapter around a file-lock acquire primitive.
 * Release errors are deliberately surfaced because a caller must not mistake
 * an uncertain lease hand-off for an ordinary successful commit.
 */
export function createFileArchiveLeaseAdapter(
  acquire: ArchiveLeaseAcquire = acquireProperLock as ArchiveLeaseAcquire,
): ArchiveLeaseAdapter {
  return {
    async withExclusiveLease<T>(
      path: string,
      timeoutMs: number,
      action: (lease: ArchiveLease) => Promise<T>,
      staleMs?: number,
    ): Promise<T> {
      const interval = 50
      const effectiveStaleMs = staleMs ?? Math.max(30_000, timeoutMs * 4)
      let compromised: Error | undefined
      let release: (() => Promise<void>)
      try {
        release = await acquire(path, {
          stale: effectiveStaleMs,
          update: Math.max(1_000, Math.floor(effectiveStaleMs / 2)),
          retries: {
            retries: Math.max(0, Math.floor(timeoutMs / interval)),
            minTimeout: interval,
            maxTimeout: interval,
            randomize: false,
          },
          realpath: false,
          onCompromised: error => { compromised = error },
        })
      } catch (error) {
        const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined
        if (code === 'ELOCKED') {
          throw new MemoryArchiveError('memory archive lease acquisition timed out', 'MEMORY_LEASE_TIMEOUT', {
            cause: error,
          })
        }
        throw error
      }
      const lease: ArchiveLease = {
        assertHeld(): void {
          if (compromised !== undefined) {
            throw new MemoryArchiveError('memory archive lease was compromised', 'MEMORY_LEASE_COMPROMISED', {
              cause: compromised,
            })
          }
        },
      }
      let result: T | undefined
      let actionError: unknown
      try {
        lease.assertHeld()
        result = await action(lease)
        lease.assertHeld()
      } catch (error) {
        actionError = error
      }
      try {
        await release()
      } catch (error) {
        throw new MemoryArchiveError('memory archive lease release failed', 'MEMORY_LEASE_RELEASE_FAILED', {
          cause: actionError ?? error,
        })
      }
      if (actionError !== undefined) throw actionError
      return result as T
    },
  }
}

const fileArchiveLeaseAdapter = createFileArchiveLeaseAdapter()

class FormatIssue extends Error {
  constructor(readonly issue: ArchiveIssue) {
    super(issue.code)
  }
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('value must be an object')
  return value as Record<string, unknown>
}

function requiredString(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error('value must be a non-empty string')
  return value
}

function parseDomainEvent(value: unknown, line: number, offset: number): MemoryDomainEvent {
  let entry: Record<string, unknown>
  try {
    entry = record(value)
  } catch {
    throw new FormatIssue({ code: 'invalid-transaction', line, offset })
  }
  if (entry.schemaVersion !== 1) {
    throw new FormatIssue({ code: 'unknown-required-event', line, offset })
  }
  try {
    if (entry.event === 'forgotten') {
      return {
        schemaVersion: 1,
        event: 'forgotten',
        id: requiredString(entry.id),
        createdAt: requiredString(entry.createdAt),
        memoryId: requiredString(entry.memoryId),
        sourceMessageId: requiredString(entry.sourceMessageId),
      }
    }
    if (entry.event === 'candidate') {
      if (entry.status !== 'pending') throw new Error('candidate must start pending')
      if (entry.visibility !== 'personal' && entry.visibility !== 'confidential') throw new Error('unsupported visibility')
      return {
        schemaVersion: 1,
        event: 'candidate',
        id: requiredString(entry.id),
        createdAt: requiredString(entry.createdAt),
        content: requiredString(entry.content),
        visibility: entry.visibility,
        sourceMessageId: requiredString(entry.sourceMessageId),
        status: 'pending',
      }
    }
    if (entry.event === 'candidate-resolution') {
      if (entry.decision !== 'approved' && entry.decision !== 'rejected') throw new Error('unsupported decision')
      return {
        schemaVersion: 1,
        event: 'candidate-resolution',
        id: requiredString(entry.id),
        createdAt: requiredString(entry.createdAt),
        candidateId: requiredString(entry.candidateId),
        decision: entry.decision,
        sourceMessageId: requiredString(entry.sourceMessageId),
        ...(entry.memoryId === undefined ? {} : { memoryId: requiredString(entry.memoryId) }),
      }
    }
    if (entry.event !== undefined) throw new FormatIssue({ code: 'unknown-required-event', line, offset })
    if (entry.status !== 'confirmed') throw new Error('memory must start confirmed')
    if (entry.visibility !== 'personal' && entry.visibility !== 'confidential') throw new Error('unsupported visibility')
    return {
      schemaVersion: 1,
      id: requiredString(entry.id),
      createdAt: requiredString(entry.createdAt),
      content: requiredString(entry.content),
      visibility: entry.visibility,
      sourceMessageId: requiredString(entry.sourceMessageId),
      ...(entry.sourceCandidateId === undefined ? {} : { sourceCandidateId: requiredString(entry.sourceCandidateId) }),
      ...(entry.supersedesMemoryId === undefined ? {} : { supersedesMemoryId: requiredString(entry.supersedesMemoryId) }),
      status: 'confirmed',
    }
  } catch (error) {
    if (error instanceof FormatIssue) throw error
    throw new FormatIssue({ code: 'invalid-transaction', line, offset })
  }
}

function emptyState(): FoldedMemoryState {
  return {
    records: [],
    candidates: [],
    byId: new Map(),
    candidateById: new Map(),
    sources: new Map(),
  }
}

function cloneMemory(memory: MemoryRecord): MemoryRecord {
  return { ...memory }
}

function cloneCandidate(candidate: MemoryCandidate): MemoryCandidate {
  return { ...candidate }
}

export function cloneFoldedState(source: FoldedMemoryState): FoldedMemoryState {
  const records = source.records.map(cloneMemory)
  const candidates = source.candidates.map(cloneCandidate)
  return {
    records,
    candidates,
    byId: new Map(records.map(memory => [memory.id, memory])),
    candidateById: new Map(candidates.map(candidate => [candidate.id, candidate])),
    sources: new Map([...source.sources].map(([id, use]) => [id, { ...use }])),
  }
}

function issue(code: ArchiveIssueCode, line: number, offset: number): never {
  throw new FormatIssue({ code, line, offset })
}

function reserveId(state: FoldedMemoryState, id: string, line: number, offset: number): void {
  if (state.byId.has(id) || state.candidateById.has(id)) issue('duplicate-id', line, offset)
}

function reserveSource(
  state: FoldedMemoryState,
  sourceMessageId: string,
  use: SourceUse,
  line: number,
  offset: number,
  allowApprovalPair = false,
): void {
  const existing = state.sources.get(sourceMessageId)
  if (existing === undefined) {
    state.sources.set(sourceMessageId, use)
    return
  }
  if (allowApprovalPair && existing.transactionId === use.transactionId && existing.kind === 'approve') return
  issue('duplicate-source', line, offset)
}

function foldEvent(
  state: FoldedMemoryState,
  event: MemoryDomainEvent,
  transactionId: string,
  line: number,
  offset: number,
): void {
  reserveId(state, event.id, line, offset)
  if ('event' in event && event.event === 'forgotten') {
    const target = state.byId.get(event.memoryId)
    if (target === undefined || target.status !== 'confirmed') issue('invalid-state-transition', line, offset)
    reserveSource(state, event.sourceMessageId, {
      kind: 'forget', transactionId, memoryId: target.id, targetMemoryId: target.id,
    }, line, offset)
    target.status = 'forgotten'
    return
  }
  if ('event' in event && event.event === 'candidate') {
    reserveSource(state, event.sourceMessageId, {
      kind: 'candidate', transactionId, candidateId: event.id, content: event.content, visibility: event.visibility,
    }, line, offset)
    state.candidates.push(event)
    state.candidateById.set(event.id, event)
    return
  }
  if ('event' in event && event.event === 'candidate-resolution') {
    const candidate = state.candidateById.get(event.candidateId)
    if (candidate === undefined || candidate.status !== 'pending') issue('invalid-state-transition', line, offset)
    if (event.decision === 'approved') {
      const memory = event.memoryId === undefined ? undefined : state.byId.get(event.memoryId)
      const source = state.sources.get(event.sourceMessageId)
      if (memory === undefined || memory.sourceCandidateId !== candidate.id || source?.kind !== 'approve'
        || source.transactionId !== transactionId || source.memoryId !== memory.id) {
        issue('invalid-state-transition', line, offset)
      }
      reserveSource(state, event.sourceMessageId, source, line, offset, true)
      candidate.status = 'approved'
    } else {
      reserveSource(state, event.sourceMessageId, {
        kind: 'reject', transactionId, candidateId: candidate.id,
      }, line, offset)
      candidate.status = 'rejected'
    }
    return
  }
  const memory = event
  if (memory.sourceCandidateId !== undefined) {
    const candidate = state.candidateById.get(memory.sourceCandidateId)
    if (candidate === undefined || candidate.status !== 'pending') issue('invalid-state-transition', line, offset)
    reserveSource(state, memory.sourceMessageId, {
      kind: 'approve', transactionId, memoryId: memory.id, candidateId: candidate.id,
      content: memory.content, visibility: memory.visibility,
    }, line, offset)
  } else if (memory.supersedesMemoryId !== undefined) {
    const target = state.byId.get(memory.supersedesMemoryId)
    if (target === undefined || target.status !== 'confirmed') issue('invalid-state-transition', line, offset)
    reserveSource(state, memory.sourceMessageId, {
      kind: 'replace', transactionId, memoryId: memory.id, targetMemoryId: target.id,
      content: memory.content, visibility: memory.visibility,
    }, line, offset)
    target.status = 'superseded'
  } else {
    reserveSource(state, memory.sourceMessageId, {
      kind: 'memory', transactionId, memoryId: memory.id, content: memory.content,
      visibility: memory.visibility, createdAt: memory.createdAt,
    }, line, offset)
  }
  state.records.push(memory)
  state.byId.set(memory.id, memory)
}

function foldTransactions(transactions: readonly ArchiveTransactionV2[]): FoldedMemoryState {
  const state = emptyState()
  for (const [transactionIndex, transaction] of transactions.entries()) {
    for (const event of transaction.events) {
      foldEvent(state, { ...event }, transaction.id, transactionIndex + 2, 0)
    }
  }
  return state
}

function canonicalValue(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('canonical JSON does not support non-finite numbers')
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(canonicalValue).join(',')}]`
  if (typeof value === 'object') {
    const source = value as Record<string, unknown>
    return `{${Object.keys(source).sort().filter(key => source[key] !== undefined)
      .map(key => `${JSON.stringify(key)}:${canonicalValue(source[key])}`).join(',')}}`
  }
  throw new TypeError(`canonical JSON does not support ${typeof value}`)
}

/** Canonical sorted JSON used by the v2 integrity protocol. */
export function canonicalArchiveJson(value: unknown): string {
  return canonicalValue(value)
}

function digest(value: unknown): string {
  return createHash('sha256').update(canonicalValue(value), 'utf8').digest('hex')
}

function headerDigest(header: ArchiveHeaderV2): string {
  return digest(header)
}

function transactionDigest(transaction: Omit<ArchiveTransactionV2, 'digest'>): string {
  return digest(transaction)
}

function contentDigest(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function lineOffsets(bytes: Buffer): Array<{ bytes: Buffer, line: number, offset: number, complete: boolean }> {
  const lines: Array<{ bytes: Buffer, line: number, offset: number, complete: boolean }> = []
  let offset = 0
  let line = 1
  while (offset < bytes.length) {
    const newline = bytes.indexOf(0x0a, offset)
    if (newline < 0) {
      lines.push({ bytes: bytes.subarray(offset), line, offset, complete: false })
      break
    }
    const end = newline > offset && bytes[newline - 1] === 0x0d ? newline - 1 : newline
    lines.push({ bytes: bytes.subarray(offset, end), line, offset, complete: true })
    offset = newline + 1
    line += 1
  }
  return lines
}

function quarantine(
  bytes: Buffer,
  format: ArchiveInspection['format'],
  transactions: number,
  events: number,
  lastValidOffset: number,
  issueValue: ArchiveIssue,
): ParsedArchive {
  return {
    inspection: {
      state: 'quarantined',
      format,
      sizeBytes: bytes.length,
      transactionCount: transactions,
      eventCount: events,
      lastValidOffset,
      digest: contentDigest(bytes),
      issues: [issueValue],
    },
  }
}

export function inspectArchiveBytes(
  bytes: Buffer,
  limits: { maxArchiveBytes: number, maxTransactionBytes: number },
): ParsedArchive {
  if (bytes.length > limits.maxArchiveBytes) {
    return quarantine(bytes, 'unknown', 0, 0, 0, { code: 'archive-too-large', line: 1, offset: 0 })
  }
  const lines = lineOffsets(bytes)
  if (lines.length === 0) {
    return {
      inspection: {
        state: 'ready', format: 'v2', sizeBytes: 0, transactionCount: 0, eventCount: 0,
        lastValidOffset: 0, digest: contentDigest(bytes), issues: [],
      },
      state: emptyState(),
    }
  }
  let first: Record<string, unknown>
  try {
    first = record(JSON.parse(lines[0]!.bytes.toString('utf8')) as unknown)
  } catch {
    const code = lines[0]!.complete ? 'interior-invalid-json' : 'trailing-partial-transaction'
    return quarantine(bytes, 'unknown', 0, 0, 0, { code, line: 1, offset: 0 })
  }
  if (first.schemaVersion === 1) {
    const legacyEvents: MemoryDomainEvent[] = []
    try {
      for (const line of lines) {
        if (line.bytes.length === 0) continue
        if (!line.complete) issue('trailing-partial-transaction', line.line, line.offset)
        let value: unknown
        try {
          value = JSON.parse(line.bytes.toString('utf8')) as unknown
        } catch {
          issue('interior-invalid-json', line.line, line.offset)
        }
        legacyEvents.push(parseDomainEvent(value, line.line, line.offset))
      }
      const state = foldTransactions([{
        kind: 'transaction', schemaVersion: 2, id: 'legacy-v1', committedAt: '1970-01-01T00:00:00.000Z',
        previousDigest: '', events: legacyEvents, digest: '',
      }])
      return {
        inspection: {
          state: 'migration-required', format: 'v1', sizeBytes: bytes.length, transactionCount: 0,
          eventCount: legacyEvents.length, lastValidOffset: bytes.length, digest: contentDigest(bytes), issues: [],
        },
        state,
      }
    } catch (error) {
      const found = error instanceof FormatIssue
        ? error.issue
        : { code: 'invalid-transaction' as const, line: 1, offset: 0 }
      return quarantine(bytes, 'v1', 0, legacyEvents.length, 0, found)
    }
  }
  if (first.schemaVersion !== 2 || first.kind !== 'mistymoon-memory-archive') {
    return quarantine(bytes, 'unknown', 0, 0, 0, { code: 'unsupported-archive-version', line: 1, offset: 0 })
  }
  let header: ArchiveHeaderV2
  try {
    const integrity = record(first.integrity)
    if (integrity.algorithm !== 'sha256' || integrity.canonicalization !== 'sorted-json-v1') throw new Error()
    header = {
      kind: 'mistymoon-memory-archive', schemaVersion: 2,
      archiveId: requiredString(first.archiveId), createdAt: requiredString(first.createdAt),
      integrity: { algorithm: 'sha256', canonicalization: 'sorted-json-v1' },
    }
  } catch {
    return quarantine(bytes, 'v2', 0, 0, 0, { code: 'invalid-header', line: 1, offset: 0 })
  }
  const transactions: ArchiveTransactionV2[] = []
  let previousDigest = headerDigest(header)
  let eventCount = 0
  let lastValidOffset = lines[0]!.offset + lines[0]!.bytes.length + (lines[0]!.complete ? 1 : 0)
  for (const line of lines.slice(1)) {
    if (line.bytes.length === 0 && line.complete) {
      lastValidOffset = line.offset + 1
      continue
    }
    if (line.bytes.length > limits.maxTransactionBytes) {
      return quarantine(bytes, 'v2', transactions.length, eventCount, lastValidOffset, {
        code: 'transaction-too-large', line: line.line, offset: line.offset,
      })
    }
    if (!line.complete) {
      return quarantine(bytes, 'v2', transactions.length, eventCount, lastValidOffset, {
        code: 'trailing-partial-transaction', line: line.line, offset: line.offset,
      })
    }
    let value: Record<string, unknown>
    try {
      value = record(JSON.parse(line.bytes.toString('utf8')) as unknown)
    } catch {
      return quarantine(bytes, 'v2', transactions.length, eventCount, lastValidOffset, {
        code: 'interior-invalid-json', line: line.line, offset: line.offset,
      })
    }
    let transaction: ArchiveTransactionV2
    try {
      if (value.kind !== 'transaction' || value.schemaVersion !== 2 || !Array.isArray(value.events) || value.events.length === 0) {
        issue('invalid-transaction', line.line, line.offset)
      }
      const events = value.events.map(event => parseDomainEvent(event, line.line, line.offset))
      transaction = {
        kind: 'transaction', schemaVersion: 2, id: requiredString(value.id),
        committedAt: requiredString(value.committedAt), previousDigest: requiredString(value.previousDigest),
        events, digest: requiredString(value.digest),
      }
      if (transaction.previousDigest !== previousDigest) issue('broken-previous-digest', line.line, line.offset)
      const { digest: suppliedDigest, ...unsigned } = transaction
      if (transactionDigest(unsigned) !== suppliedDigest) issue('digest-mismatch', line.line, line.offset)
      foldEventValidation(transactions, transaction, line.line, line.offset)
    } catch (error) {
      const found = error instanceof FormatIssue
        ? error.issue
        : { code: 'invalid-transaction' as const, line: line.line, offset: line.offset }
      return quarantine(bytes, 'v2', transactions.length, eventCount, lastValidOffset, found)
    }
    transactions.push(transaction)
    eventCount += transaction.events.length
    previousDigest = transaction.digest
    lastValidOffset = line.offset + line.bytes.length + 1
  }
  let state: FoldedMemoryState
  try {
    state = foldTransactions(transactions)
  } catch (error) {
    const found = error instanceof FormatIssue
      ? error.issue
      : { code: 'invalid-state-transition' as const, line: 1, offset: 0 }
    return quarantine(bytes, 'v2', transactions.length, eventCount, lastValidOffset, found)
  }
  return {
    inspection: {
      state: 'ready', format: 'v2', sizeBytes: bytes.length, transactionCount: transactions.length,
      eventCount, lastValidOffset, digest: contentDigest(bytes), issues: [],
    },
    state,
    header,
    lastDigest: previousDigest,
  }
}

/** Convert one already-inspected v1 archive into one atomic v2 migration transaction. */
export function migrateV1ArchiveBytes(
  bytes: Buffer,
  options: { now?: () => Date, createId?: () => string } = {},
): Buffer {
  const limits = { maxArchiveBytes: Number.MAX_SAFE_INTEGER, maxTransactionBytes: Number.MAX_SAFE_INTEGER }
  const parsed = inspectArchiveBytes(bytes, limits)
  if (parsed.inspection.state !== 'migration-required' || parsed.inspection.format !== 'v1') {
    throw new Error('only a valid v1 memory archive can be migrated')
  }
  const events = lineOffsets(bytes).flatMap(line => {
    if (line.bytes.length === 0) return []
    return [parseDomainEvent(JSON.parse(line.bytes.toString('utf8')) as unknown, line.line, line.offset)]
  })
  const now = options.now ?? (() => new Date())
  const createId = options.createId ?? randomUUID
  const timestamp = now().toISOString()
  const header: ArchiveHeaderV2 = {
    kind: 'mistymoon-memory-archive', schemaVersion: 2, archiveId: createId(), createdAt: timestamp,
    integrity: { algorithm: 'sha256', canonicalization: 'sorted-json-v1' },
  }
  const unsigned = {
    kind: 'transaction' as const,
    schemaVersion: 2 as const,
    id: createId(),
    committedAt: timestamp,
    previousDigest: headerDigest(header),
    events,
  }
  const transaction: ArchiveTransactionV2 = { ...unsigned, digest: transactionDigest(unsigned) }
  return Buffer.from(`${canonicalValue(header)}\n${canonicalValue(transaction)}\n`, 'utf8')
}

function foldEventValidation(
  previous: readonly ArchiveTransactionV2[],
  transaction: ArchiveTransactionV2,
  line: number,
  offset: number,
): void {
  try {
    foldTransactions([...previous, transaction])
  } catch (error) {
    if (error instanceof FormatIssue) throw new FormatIssue({ ...error.issue, line, offset })
    throw error
  }
}

function copyInspection(value: ArchiveInspection): ArchiveInspection {
  return { ...value, issues: value.issues.map(issueValue => ({ ...issueValue })) }
}

async function readArchive(path: string): Promise<Buffer> {
  try {
    return await readFile(path)
  } catch (error) {
    if (error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT') return Buffer.alloc(0)
    throw error
  }
}

const fileArchiveCommitWriter: ArchiveCommitWriter = {
  async appendAndFlush(path, bytes): Promise<void> {
    const handle = await open(path, 'a')
    try {
      await handle.writeFile(bytes)
      await handle.sync()
    } finally {
      await handle.close()
    }
  },
}

const fileArchiveCheckpointWriter: ArchiveCheckpointWriter = {
  write: writeArchiveCheckpoint,
}

function checkpointPath(path: string): string {
  return `${path}.checkpoint`
}

function checkpointFor(parsed: ParsedArchive): ArchiveCheckpointV1 {
  if (parsed.inspection.state !== 'ready' || parsed.lastDigest === undefined) {
    throw new Error('cannot checkpoint an unavailable memory archive')
  }
  return {
    schemaVersion: 1,
    archiveDigest: parsed.inspection.digest,
    archiveSize: parsed.inspection.sizeBytes,
    transactionCount: parsed.inspection.transactionCount,
    eventCount: parsed.inspection.eventCount,
    lastTransactionDigest: parsed.lastDigest,
  }
}

export async function writeArchiveCheckpoint(path: string, parsed: ParsedArchive): Promise<void> {
  const target = checkpointPath(path)
  const temporary = `${target}.${randomUUID()}.tmp`
  const handle = await open(temporary, 'wx', 0o600)
  try {
    await handle.writeFile(`${canonicalValue(checkpointFor(parsed))}\n`, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await rename(temporary, target)
  } finally {
    await rm(temporary, { force: true })
  }
}

export async function verifyArchiveCheckpoint(
  path: string,
  parsed: ParsedArchive,
  createIfMissing = false,
): Promise<ParsedArchive> {
  if (parsed.inspection.state !== 'ready') return parsed
  let value: unknown
  try {
    value = JSON.parse(await readFile(checkpointPath(path), 'utf8')) as unknown
  } catch (error) {
    if (error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT' && createIfMissing) {
      await writeArchiveCheckpoint(path, parsed)
      return parsed
    }
    return {
      inspection: {
        ...parsed.inspection,
        state: 'quarantined',
        issues: [{ code: 'checkpoint-mismatch', line: 0, offset: 0 }],
      },
    }
  }
  let checkpoint: ArchiveCheckpointV1
  try {
    const source = record(value)
    checkpoint = {
      schemaVersion: source.schemaVersion === 1 ? 1 : (() => { throw new Error() })(),
      archiveDigest: requiredString(source.archiveDigest),
      archiveSize: typeof source.archiveSize === 'number' ? source.archiveSize : (() => { throw new Error() })(),
      transactionCount: typeof source.transactionCount === 'number' ? source.transactionCount : (() => { throw new Error() })(),
      eventCount: typeof source.eventCount === 'number' ? source.eventCount : (() => { throw new Error() })(),
      lastTransactionDigest: requiredString(source.lastTransactionDigest),
    }
  } catch {
    return {
      inspection: {
        ...parsed.inspection,
        state: 'quarantined',
        issues: [{ code: 'checkpoint-mismatch', line: 0, offset: 0 }],
      },
    }
  }
  const expected = checkpointFor(parsed)
  if (canonicalValue(checkpoint) !== canonicalValue(expected)) {
    return {
      inspection: {
        ...parsed.inspection,
        state: 'quarantined',
        issues: [{ code: 'checkpoint-mismatch', line: 0, offset: 0 }],
      },
    }
  }
  return parsed
}

export class MemoryArchiveStorage {
  readonly #path: string
  readonly #now: () => Date
  readonly #createTransactionId: () => string
  readonly #leaseTimeoutMs: number
  readonly #leaseStaleMs: number
  readonly #maxArchiveBytes: number
  readonly #maxTransactionBytes: number
  readonly #disposeTimeoutMs: number
  readonly #leaseAdapter: ArchiveLeaseAdapter
  readonly #commitWriter: ArchiveCommitWriter
  readonly #checkpointWriter: ArchiveCheckpointWriter
  #parsed: ParsedArchive
  #disposed = false
  readonly #inflight = new Set<Promise<unknown>>()

  private constructor(options: MemoryArchiveStorageOptions, parsed: ParsedArchive) {
    this.#path = options.path
    this.#now = options.now ?? (() => new Date())
    this.#createTransactionId = options.createTransactionId ?? randomUUID
    this.#leaseTimeoutMs = options.leaseTimeoutMs ?? 30_000
    this.#leaseStaleMs = options.leaseStaleMs ?? 120_000
    this.#maxArchiveBytes = options.maxArchiveBytes ?? 64 * 1024 * 1024
    this.#maxTransactionBytes = options.maxTransactionBytes ?? 1024 * 1024
    this.#disposeTimeoutMs = options.disposeTimeoutMs ?? 5_000
    this.#leaseAdapter = options.leaseAdapter ?? fileArchiveLeaseAdapter
    this.#commitWriter = options.commitWriter ?? fileArchiveCommitWriter
    this.#checkpointWriter = options.checkpointWriter ?? fileArchiveCheckpointWriter
    this.#parsed = parsed
  }

  static async open(options: MemoryArchiveStorageOptions): Promise<MemoryArchiveStorage> {
    const limits = {
      maxArchiveBytes: options.maxArchiveBytes ?? 64 * 1024 * 1024,
      maxTransactionBytes: options.maxTransactionBytes ?? 1024 * 1024,
    }
    const now = options.now ?? (() => new Date())
    await mkdir(dirname(options.path), { recursive: true })
    const parsed = await MemoryArchiveStorage.withExclusiveLease(options.path, options.leaseTimeoutMs ?? 30_000, async () => {
      const bytes = await readArchive(options.path)
      const created = bytes.length === 0
      if (created) {
        const header: ArchiveHeaderV2 = {
          kind: 'mistymoon-memory-archive', schemaVersion: 2, archiveId: randomUUID(),
          createdAt: now().toISOString(), integrity: { algorithm: 'sha256', canonicalization: 'sorted-json-v1' },
        }
        const handle = await open(options.path, 'w')
        try {
          await handle.writeFile(`${canonicalValue(header)}\n`, 'utf8')
          await handle.sync()
        } finally {
          await handle.close()
        }
      }
      return verifyArchiveCheckpoint(
        options.path,
        inspectArchiveBytes(await readArchive(options.path), limits),
        created,
      )
    }, options.leaseAdapter ?? fileArchiveLeaseAdapter, options.leaseStaleMs ?? 120_000)
    return new MemoryArchiveStorage(options, parsed)
  }

  static async withExclusiveLease<T>(
    path: string,
    timeoutMs: number,
    action: (lease: ArchiveLease) => Promise<T>,
    adapter: ArchiveLeaseAdapter = fileArchiveLeaseAdapter,
    staleMs?: number,
  ): Promise<T> {
    return adapter.withExclusiveLease(path, timeoutMs, action, staleMs)
  }

  inspection(): ArchiveInspection {
    return copyInspection(this.#parsed.inspection)
  }

  snapshot(): FoldedMemoryState | undefined {
    return this.#parsed.inspection.state === 'ready' && this.#parsed.state !== undefined
      ? cloneFoldedState(this.#parsed.state)
      : undefined
  }

  async transact<T>(mutate: (state: FoldedMemoryState) => ArchiveMutation<T>): Promise<T> {
    if (this.#disposed) throw new MemoryArchiveError('memory archive is disposed', 'MEMORY_ARCHIVE_DISPOSED')
    const operation = this.#transact(mutate)
    this.#inflight.add(operation)
    try {
      return await operation
    } finally {
      this.#inflight.delete(operation)
    }
  }

  async #transact<T>(mutate: (state: FoldedMemoryState) => ArchiveMutation<T>): Promise<T> {
    const next = await this.#leaseAdapter.withExclusiveLease(this.#path, this.#leaseTimeoutMs, async lease => {
      const parsed = await verifyArchiveCheckpoint(this.#path, inspectArchiveBytes(await readArchive(this.#path), {
        maxArchiveBytes: this.#maxArchiveBytes,
        maxTransactionBytes: this.#maxTransactionBytes,
      }))
      if (parsed.inspection.state === 'migration-required') {
        throw new MemoryArchiveError('memory archive requires explicit v1 migration', 'MEMORY_ARCHIVE_MIGRATION_REQUIRED')
      }
      if (parsed.inspection.state !== 'ready' || parsed.state === undefined || parsed.lastDigest === undefined) {
        throw new MemoryArchiveError('memory archive is quarantined', 'MEMORY_ARCHIVE_QUARANTINED')
      }
      const mutation = mutate(cloneFoldedState(parsed.state))
      if (mutation.events.length === 0) return { parsed, result: mutation.result }
      lease.assertHeld()
      const unsigned = {
        kind: 'transaction' as const,
        schemaVersion: 2 as const,
        id: this.#createTransactionId(),
        committedAt: this.#now().toISOString(),
        previousDigest: parsed.lastDigest,
        events: mutation.events,
      }
      const transaction: ArchiveTransactionV2 = { ...unsigned, digest: transactionDigest(unsigned) }
      const bytes = Buffer.from(`${canonicalValue(transaction)}\n`, 'utf8')
      if (bytes.length > this.#maxTransactionBytes) {
        throw new Error('memory transaction exceeds configured maximum bytes')
      }
      if (parsed.inspection.sizeBytes + bytes.length > this.#maxArchiveBytes) {
        throw new Error('memory archive exceeds configured maximum bytes')
      }
      await this.#commitWriter.appendAndFlush(this.#path, bytes)
      lease.assertHeld()
      const verified = inspectArchiveBytes(await readArchive(this.#path), {
        maxArchiveBytes: this.#maxArchiveBytes,
        maxTransactionBytes: this.#maxTransactionBytes,
      })
      if (verified.inspection.state !== 'ready') {
        throw new MemoryArchiveError('memory archive became quarantined after commit', 'MEMORY_ARCHIVE_QUARANTINED')
      }
      await this.#checkpointWriter.write(this.#path, verified)
      lease.assertHeld()
      return { parsed: verified, result: mutation.result }
    }, this.#leaseStaleMs)
    this.#parsed = next.parsed
    return next.result
  }

  async dispose(): Promise<void> {
    this.#disposed = true
    const inflight = [...this.#inflight]
    if (inflight.length === 0) return
    let timeout: NodeJS.Timeout | undefined
    try {
      await Promise.race([
        Promise.allSettled(inflight).then(() => undefined),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => {
            reject(new MemoryArchiveError('memory archive dispose timed out', 'MEMORY_DISPOSE_TIMEOUT'))
          }, this.#disposeTimeoutMs)
        }),
      ])
    } finally {
      if (timeout !== undefined) clearTimeout(timeout)
    }
  }
}
