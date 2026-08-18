/**
 * Durable companion memory for MistyMoon on DSH.
 * @module @mistymoon/dsh-memory
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import { defineTool, type ToolExecution, type ValueSchemaSpec } from '@deepseek-ai/dsh-tools'
import type {
  CompanionMemoryArchive,
  ConfirmedMemoryImport,
  ConfirmedMemoryImportResult,
  ExplicitMemoryObservation,
  MemoryCandidate,
  MemoryCandidateDecision,
  MemoryCandidateList,
  MemoryCandidateProposal,
  MemoryForget,
  MemoryList,
  MemoryRecall,
  MemoryRecord,
  MemoryReplace,
  MemoryVisibility,
} from './contracts.js'
import { DEFAULT_RECALL_LIMIT, loadMemoryRuntimeSettings } from './runtime-settings.js'
import {
  MemoryArchiveError,
  MemoryArchiveStorage,
  type ArchiveInspection,
  type FoldedMemoryState,
  type MemoryCandidateResolutionEvent,
  type MemoryForgottenEvent,
  type SourceUse,
} from './storage/index.js'

export * from './contracts.js'
export * from './runtime-settings.js'

/** Cordis plugin name and durable user-message source id. */
export const name = 'mistymoon-memory'

/** Agent pre-step waterfall used for durable memory projection. */
export const inject = ['agents', 'tools', 'mistymoonOwnerEligibility']

/** Memory plugin configuration. */
export interface Config {
  /** Private append-only JSONL path. */
  path: string
  /** Maximum memories included in one model-visible snapshot. */
  recallLimit?: number
  /** Optional private owner settings document read before each recall. */
  settingsPath?: string
  /** Maximum time to wait for the cross-process archive lease. */
  leaseTimeoutMs?: number
  /** Age after which an unrefreshed archive lease may be reclaimed. */
  leaseStaleMs?: number
  /** Maximum time dispose waits for already-started commits. */
  disposeTimeoutMs?: number
  /** Maximum accepted archive size before fail-closed quarantine. */
  maxArchiveBytes?: number
  /** Maximum accepted size of one transaction envelope. */
  maxTransactionBytes?: number
}

/** Runtime schema for the memory plugin. */
export const Config: z<Config> = z.object({
  path: z.string().required(),
  recallLimit: z.number().step(1).min(1).max(20).default(DEFAULT_RECALL_LIMIT),
  settingsPath: z.string(),
  leaseTimeoutMs: z.number().step(1).min(100).max(60_000).default(30_000),
  leaseStaleMs: z.number().step(1).min(5_000).max(600_000).default(120_000),
  disposeTimeoutMs: z.number().step(1).min(100).max(60_000).default(5_000),
  maxArchiveBytes: z.number().step(1).min(1_048_576).max(1_073_741_824).default(67_108_864),
  maxTransactionBytes: z.number().step(1).min(1_024).max(16_777_216).default(1_048_576),
})

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Process-wide MistyMoon archive shared by tools and local governance UI. */
    mistymoonMemory: CompanionMemoryArchive
  }
}

/** Construction inputs for a private memory archive. */
export interface OpenMemoryArchiveOptions {
  path: string
  createId?: () => string
  now?: () => Date
  leaseTimeoutMs?: number
  leaseStaleMs?: number
  maxArchiveBytes?: number
  maxTransactionBytes?: number
  disposeTimeoutMs?: number
}

function explicitContent(text: string): string | undefined {
  const match = text.match(/(?:请|帮我)?记住[：:，,\s]*(.+)$/su)
  return match?.[1]?.trim() || undefined
}

function lexicalUnits(value: string): Set<string> {
  const normalized = value.toLocaleLowerCase()
  const units = new Set(normalized.match(/[a-z0-9]{2,}|[\p{Script=Han}]{2,}/gu) ?? [])
  for (const sequence of normalized.match(/[\p{Script=Han}]{2,}/gu) ?? []) {
    for (let index = 0; index < sequence.length - 1; index += 1) units.add(sequence.slice(index, index + 2))
  }
  return units
}

function lexicalScore(query: string, content: string): number {
  const queryUnits = lexicalUnits(query)
  if (queryUnits.size === 0) return 0
  const contentUnits = lexicalUnits(content)
  let overlap = 0
  for (const unit of queryUnits) if (contentUnits.has(unit)) overlap += 1
  return overlap / queryUnits.size
}

function conflict(sourceMessageId: string): never {
  throw new MemoryArchiveError(
    `memory sourceMessageId ${JSON.stringify(sourceMessageId)} conflicts with an earlier command`,
    'MEMORY_SOURCE_CONFLICT',
  )
}

function existingMemory(state: FoldedMemoryState, use: SourceUse): MemoryRecord {
  const memory = use.memoryId === undefined ? undefined : state.byId.get(use.memoryId)
  if (memory === undefined) throw new Error('memory archive source result is unavailable')
  return memory
}

class StorageBackedMemoryArchive implements CompanionMemoryArchive {
  readonly #candidateReferences = new Map<string, Set<MemoryCandidate>>()

  constructor(
    private readonly storage: MemoryArchiveStorage,
    private readonly createId: () => string,
    private readonly now: () => Date,
  ) {}

  inspection(): ArchiveInspection {
    return this.storage.inspection()
  }

  dispose(): Promise<void> {
    return this.storage.dispose()
  }

  async observeExplicit(input: ExplicitMemoryObservation): Promise<MemoryRecord | undefined> {
    const content = explicitContent(input.text)
    if (content === undefined) return undefined
    const visibility: MemoryVisibility = /保密|不要告诉|别告诉|不能告诉/u.test(input.text) ? 'confidential' : 'personal'
    return this.storage.transact(state => {
      const used = state.sources.get(input.sourceMessageId)
      if (used !== undefined) {
        if (used.kind === 'memory' && used.content === content && used.visibility === visibility) {
          return { events: [], result: existingMemory(state, used) }
        }
        return conflict(input.sourceMessageId)
      }
      const memory: MemoryRecord = {
        schemaVersion: 1, id: this.createId(), createdAt: this.now().toISOString(), content, visibility,
        sourceMessageId: input.sourceMessageId, status: 'confirmed',
      }
      return { events: [memory], result: memory }
    })
  }

  recall(input: MemoryRecall): MemoryRecord[] {
    const state = this.storage.snapshot()
    if (state === undefined) return []
    const limit = Math.max(0, input.limit ?? 8)
    const query = input.query.trim()
    return state.records
      .filter(memory => memory.status === 'confirmed')
      .map(memory => ({ memory, score: query === '' ? 1 : lexicalScore(query, memory.content) }))
      .filter(item => query === '' || item.score > 0)
      .sort((left, right) => right.score - left.score || right.memory.createdAt.localeCompare(left.memory.createdAt))
      .slice(0, limit)
      .map(item => item.memory)
  }

  list(input: MemoryList = {}): MemoryRecord[] {
    const state = this.storage.snapshot()
    if (state === undefined) return []
    const limit = Math.max(0, input.limit ?? 100)
    return state.records
      .filter(memory => input.includeInactive === true || memory.status === 'confirmed')
      .map((memory, index) => ({ memory, index }))
      .toSorted((left, right) => right.memory.createdAt.localeCompare(left.memory.createdAt) || right.index - left.index)
      .slice(0, limit)
      .map(item => item.memory)
  }

  async forget(input: MemoryForget): Promise<MemoryRecord> {
    return this.storage.transact(state => {
      const used = state.sources.get(input.sourceMessageId)
      if (used !== undefined) {
        if (used.kind === 'forget' && used.targetMemoryId === input.memoryId) return { events: [], result: existingMemory(state, used) }
        return conflict(input.sourceMessageId)
      }
      const memory = state.byId.get(input.memoryId)
      if (memory === undefined) throw new Error(`memory ${JSON.stringify(input.memoryId)} does not exist`)
      if (memory.status !== 'confirmed') throw new Error(`memory ${JSON.stringify(input.memoryId)} is already ${memory.status}`)
      const event: MemoryForgottenEvent = {
        schemaVersion: 1, event: 'forgotten', id: this.createId(), createdAt: this.now().toISOString(),
        memoryId: memory.id, sourceMessageId: input.sourceMessageId,
      }
      memory.status = 'forgotten'
      return { events: [event], result: memory }
    })
  }

  async replace(input: MemoryReplace): Promise<MemoryRecord> {
    const content = input.content.trim()
    if (content === '') throw new Error('replacement memory content must be a non-empty string')
    return this.storage.transact(state => {
      const used = state.sources.get(input.sourceMessageId)
      if (used !== undefined) {
        if (used.kind === 'replace' && used.targetMemoryId === input.memoryId && used.content === content) {
          return { events: [], result: existingMemory(state, used) }
        }
        return conflict(input.sourceMessageId)
      }
      const target = state.byId.get(input.memoryId)
      if (target === undefined) throw new Error(`memory ${JSON.stringify(input.memoryId)} does not exist`)
      if (target.status !== 'confirmed') throw new Error(`memory ${JSON.stringify(input.memoryId)} is already ${target.status}`)
      const memory: MemoryRecord = {
        schemaVersion: 1, id: this.createId(), createdAt: this.now().toISOString(), content,
        visibility: target.visibility, sourceMessageId: input.sourceMessageId,
        supersedesMemoryId: target.id, status: 'confirmed',
      }
      target.status = 'superseded'
      return { events: [memory], result: memory }
    })
  }

  async importConfirmed(input: ConfirmedMemoryImport): Promise<ConfirmedMemoryImportResult> {
    const content = input.content.trim()
    if (content === '') throw new Error('imported memory content must be a non-empty string')
    const createdAt = new Date(input.createdAt)
    if (Number.isNaN(createdAt.getTime())) throw new Error(`invalid imported memory timestamp ${JSON.stringify(input.createdAt)}`)
    const timestamp = createdAt.toISOString()
    return this.storage.transact<ConfirmedMemoryImportResult>(state => {
      const used = state.sources.get(input.sourceMessageId)
      if (used !== undefined) {
        if (used.kind === 'memory' && used.content === content && used.visibility === input.visibility && used.createdAt === timestamp) {
          return { events: [], result: { memory: existingMemory(state, used), imported: false } }
        }
        return conflict(input.sourceMessageId)
      }
      const memory: MemoryRecord = {
        schemaVersion: 1, id: this.createId(), createdAt: timestamp, content, visibility: input.visibility,
        sourceMessageId: input.sourceMessageId, status: 'confirmed',
      }
      return { events: [memory], result: { memory, imported: true } }
    })
  }

  async propose(input: MemoryCandidateProposal): Promise<MemoryCandidate> {
    const content = input.content.trim()
    if (content === '') throw new Error('candidate memory content must be a non-empty string')
    const candidate = await this.storage.transact(state => {
      const used = state.sources.get(input.sourceMessageId)
      if (used !== undefined) {
        if (used.kind === 'candidate' && used.content === content && used.visibility === input.visibility) {
          const candidate = used.candidateId === undefined ? undefined : state.candidateById.get(used.candidateId)
          if (candidate !== undefined) return { events: [], result: candidate }
        }
        return conflict(input.sourceMessageId)
      }
      const candidate: MemoryCandidate = {
        schemaVersion: 1, event: 'candidate', id: this.createId(), createdAt: this.now().toISOString(),
        content, visibility: input.visibility, sourceMessageId: input.sourceMessageId, status: 'pending',
      }
      return { events: [candidate], result: candidate }
    })
    this.#rememberCandidateReference(candidate)
    return candidate
  }

  listCandidates(input: MemoryCandidateList = {}): MemoryCandidate[] {
    const state = this.storage.snapshot()
    if (state === undefined) return []
    const limit = Math.max(0, input.limit ?? 100)
    const candidates = state.candidates
      .filter(candidate => input.includeResolved === true || candidate.status === 'pending')
      .map((candidate, index) => ({ candidate, index }))
      .toSorted((left, right) => right.candidate.createdAt.localeCompare(left.candidate.createdAt) || right.index - left.index)
      .slice(0, limit)
      .map(item => item.candidate)
    for (const candidate of candidates) this.#rememberCandidateReference(candidate)
    return candidates
  }

  async approveCandidate(input: MemoryCandidateDecision): Promise<MemoryRecord> {
    const memory = await this.storage.transact(state => {
      const used = state.sources.get(input.sourceMessageId)
      if (used !== undefined) {
        if (used.kind === 'approve' && used.candidateId === input.candidateId) return { events: [], result: existingMemory(state, used) }
        return conflict(input.sourceMessageId)
      }
      const candidate = state.candidateById.get(input.candidateId)
      if (candidate === undefined) throw new Error(`memory candidate ${JSON.stringify(input.candidateId)} does not exist`)
      if (candidate.status !== 'pending') throw new Error(`memory candidate ${JSON.stringify(input.candidateId)} is already ${candidate.status}`)
      const timestamp = this.now().toISOString()
      const approved: MemoryRecord = {
        schemaVersion: 1, id: this.createId(), createdAt: timestamp, content: candidate.content,
        visibility: candidate.visibility, sourceMessageId: input.sourceMessageId,
        sourceCandidateId: candidate.id, status: 'confirmed',
      }
      const resolution: MemoryCandidateResolutionEvent = {
        schemaVersion: 1, event: 'candidate-resolution', id: this.createId(), createdAt: timestamp,
        candidateId: candidate.id, decision: 'approved', sourceMessageId: input.sourceMessageId,
        memoryId: approved.id,
      }
      candidate.status = 'approved'
      return { events: [approved, resolution], result: approved }
    })
    for (const candidate of this.#candidateReferences.get(input.candidateId) ?? []) candidate.status = 'approved'
    return memory
  }

  async rejectCandidate(input: MemoryCandidateDecision): Promise<MemoryCandidate> {
    const candidate = await this.storage.transact(state => {
      const used = state.sources.get(input.sourceMessageId)
      if (used !== undefined) {
        if (used.kind === 'reject' && used.candidateId === input.candidateId) {
          const existing = state.candidateById.get(input.candidateId)
          if (existing !== undefined) return { events: [], result: existing }
        }
        return conflict(input.sourceMessageId)
      }
      const pending = state.candidateById.get(input.candidateId)
      if (pending === undefined) throw new Error(`memory candidate ${JSON.stringify(input.candidateId)} does not exist`)
      if (pending.status !== 'pending') throw new Error(`memory candidate ${JSON.stringify(input.candidateId)} is already ${pending.status}`)
      const resolution: MemoryCandidateResolutionEvent = {
        schemaVersion: 1, event: 'candidate-resolution', id: this.createId(), createdAt: this.now().toISOString(),
        candidateId: pending.id, decision: 'rejected', sourceMessageId: input.sourceMessageId,
      }
      pending.status = 'rejected'
      return { events: [resolution], result: pending }
    })
    for (const reference of this.#candidateReferences.get(input.candidateId) ?? []) reference.status = 'rejected'
    this.#rememberCandidateReference(candidate)
    return candidate
  }

  #rememberCandidateReference(candidate: MemoryCandidate): void {
    const references = this.#candidateReferences.get(candidate.id) ?? new Set<MemoryCandidate>()
    references.add(candidate)
    this.#candidateReferences.set(candidate.id, references)
  }
}

/** Open the owner-private v2 archive; legacy or damaged archives remain inspectable but fail closed. */
export async function openMemoryArchive(options: OpenMemoryArchiveOptions): Promise<CompanionMemoryArchive> {
  const now = options.now ?? (() => new Date())
  const storage = await MemoryArchiveStorage.open({
    path: options.path,
    now,
    leaseTimeoutMs: options.leaseTimeoutMs,
    leaseStaleMs: options.leaseStaleMs,
    maxArchiveBytes: options.maxArchiveBytes,
    maxTransactionBytes: options.maxTransactionBytes,
    disposeTimeoutMs: options.disposeTimeoutMs,
  })
  return new StorageBackedMemoryArchive(storage, options.createId ?? randomUUID, now)
}

function userText(message: UserMessage): string {
  return message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n').trim()
}

function recallSnapshot(memories: readonly MemoryRecord[]): string {
  return 'Relevant confirmed companion memories. Use them only when relevant; '
    + 'do not reveal confidential details without owner intent:\n'
    + memories.map(memory => `- ${memory.content}`).join('\n')
}

const memoryValueSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    schemaVersion: { type: 'integer', required: true },
    id: { type: 'string', required: true },
    createdAt: { type: 'string', required: true },
    content: { type: 'string', required: true },
    visibility: { type: 'string', required: true, enum: ['personal', 'confidential'] },
    sourceMessageId: { type: 'string', required: true },
    sourceCandidateId: { type: 'string' },
    supersedesMemoryId: { type: 'string' },
    status: { type: 'string', required: true, enum: ['confirmed', 'forgotten', 'superseded'] },
  },
} as const satisfies ValueSchemaSpec

const memoryCandidateValueSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    schemaVersion: { type: 'integer', required: true },
    event: { type: 'string', required: true, enum: ['candidate'] },
    id: { type: 'string', required: true },
    createdAt: { type: 'string', required: true },
    content: { type: 'string', required: true },
    visibility: { type: 'string', required: true, enum: ['personal', 'confidential'] },
    sourceMessageId: { type: 'string', required: true },
    status: { type: 'string', required: true, enum: ['pending', 'approved', 'rejected'] },
  },
} as const satisfies ValueSchemaSpec

function toolSourceMessageId(callId: unknown, agentId?: unknown): string {
  return `memory-tool:${agentId === undefined ? 'unowned' : String(agentId)}:${String(callId)}`
}

function boundedListLimit(limit: number | undefined): number {
  const resolved = limit ?? 20
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > 100) {
    throw new Error(`memory list limit must be an integer from 1 through 100, got ${String(resolved)}`)
  }
  return resolved
}

interface MemoryOwnerEligibility {
  ownerMessages(agent: Agent, messages: readonly UserMessage[]): readonly UserMessage[]
  evaluateCurrentTurn(agent: Agent): { readonly eligible: boolean }
}

function ownerEligibility(ctx: Context): MemoryOwnerEligibility {
  return ctx.get('mistymoonOwnerEligibility', true) as MemoryOwnerEligibility
}

const MEMORY_TOOL_NAMES = new Set([
  'memory_candidate_propose',
  'memory_candidate_list',
  'memory_candidate_approve',
  'memory_candidate_reject',
  'memory_list',
  'memory_forget',
  'memory_replace',
])

function memoryOwnerGuard(ctx: Context, execution: Readonly<ToolExecution>): string | undefined {
  if (!MEMORY_TOOL_NAMES.has(execution.name)) return undefined
  const agent = execution.agent
  if (agent !== undefined && ownerEligibility(ctx).evaluateCurrentTurn(agent).eligible) {
    return undefined
  }
  return 'MistyMoon memory tools require an authenticated Owner request in the active top-level turn.'
}

function registerMemoryTools(ctx: Context, archive: CompanionMemoryArchive): void {
  ctx.tools.register(defineTool({
    name: 'memory_candidate_propose',
    description: 'Propose a durable companion memory inferred from the owner\'s messages. The proposal is not recalled '
      + 'until the owner explicitly reviews and approves it. Never use this for secrets unless the owner clearly asks.',
    parameters: {
      content: { type: 'string', required: true, description: 'One complete, durable fact stated without speculation.' },
      visibility: {
        type: 'string',
        enum: ['personal', 'confidential'],
        description: 'Use confidential for sensitive facts; defaults to personal.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { candidate: { ...memoryCandidateValueSchema, required: true } },
      },
      render: (_args, result) => [{ type: 'text', text: `Proposed companion memory ${result.candidate.id} for owner review.` }],
    },
    async execute(args, exec) {
      return {
        candidate: await archive.propose({
          content: args.content,
          visibility: args.visibility ?? 'personal',
          sourceMessageId: toolSourceMessageId(exec.callId, exec.agent?.id),
        }),
      }
    },
    presentCall: args => ({ card: 'generic', title: 'Propose companion memory', kind: 'edit', rawInput: args }),
  }))

  ctx.tools.register(defineTool({
    name: 'memory_candidate_list',
    description: 'List companion-memory proposals awaiting owner review. Include resolved history only for an audit request.',
    parameters: {
      includeResolved: { type: 'boolean', description: 'Include approved and rejected candidates.' },
      limit: { type: 'integer', description: 'Maximum results from 1 through 100.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          candidates: { type: 'array', required: true, items: memoryCandidateValueSchema },
        },
      },
      render: (_args, result) => [{
        type: 'text',
        text: result.candidates.length === 0
          ? 'No companion-memory proposals await review.'
          : `Found ${result.candidates.length} companion-memory ${result.candidates.length === 1 ? 'proposal' : 'proposals'}.`,
      }],
    },
    execute(args) {
      return Promise.resolve({
        candidates: archive.listCandidates({
          includeResolved: args.includeResolved,
          limit: boundedListLimit(args.limit),
        }),
      })
    },
    presentCall: args => ({ card: 'generic', title: 'Review memory proposals', kind: 'search', rawInput: args }),
  }))

  ctx.tools.register(defineTool({
    name: 'memory_candidate_approve',
    description: 'Approve one pending companion-memory proposal only after clear owner authorization. '
      + 'Approval creates a confirmed memory that can participate in later recall.',
    parameters: {
      candidateId: { type: 'string', required: true, description: 'Exact candidate id returned by memory_candidate_list.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { memory: { ...memoryValueSchema, required: true } },
      },
      render: (_args, result) => [{ type: 'text', text: `Approved companion memory ${result.memory.id}.` }],
    },
    async execute(args, exec) {
      return {
        memory: await archive.approveCandidate({
          candidateId: args.candidateId,
          sourceMessageId: toolSourceMessageId(exec.callId, exec.agent?.id),
        }),
      }
    },
    presentCall: args => ({ card: 'generic', title: 'Approve companion memory', kind: 'edit', rawInput: args }),
  }))

  ctx.tools.register(defineTool({
    name: 'memory_candidate_reject',
    description: 'Reject one pending companion-memory proposal only after clear owner authorization. '
      + 'The rejected proposal remains in private audit history and is never recalled.',
    parameters: {
      candidateId: { type: 'string', required: true, description: 'Exact candidate id returned by memory_candidate_list.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { candidate: { ...memoryCandidateValueSchema, required: true } },
      },
      render: (_args, result) => [{ type: 'text', text: `Rejected companion-memory proposal ${result.candidate.id}.` }],
    },
    async execute(args, exec) {
      return {
        candidate: await archive.rejectCandidate({
          candidateId: args.candidateId,
          sourceMessageId: toolSourceMessageId(exec.callId, exec.agent?.id),
        }),
      }
    },
    presentCall: args => ({ card: 'generic', title: 'Reject memory proposal', kind: 'delete', rawInput: args }),
  }))

  ctx.tools.register(defineTool({
    name: 'memory_list',
    description: 'List the owner\'s confirmed companion memories. Use a query to find relevant active memories; '
      + 'omit it to review recent memories. Include inactive history only when the owner asks to audit past changes.',
    parameters: {
      query: { type: 'string', description: 'Optional lexical search query over active memories.' },
      includeInactive: { type: 'boolean', description: 'Include forgotten and superseded memories when no query is supplied.' },
      limit: { type: 'integer', description: 'Maximum results from 1 through 100.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          memories: { type: 'array', required: true, items: memoryValueSchema },
        },
      },
      render: (_args, result) => [{
        type: 'text',
        text: result.memories.length === 0
          ? 'No matching companion memories.'
          : `Found ${result.memories.length} companion ${result.memories.length === 1 ? 'memory' : 'memories'}.`,
      }],
    },
    execute(args) {
      const limit = boundedListLimit(args.limit)
      const query = args.query?.trim()
      const memories = query === undefined || query === ''
        ? archive.list({ includeInactive: args.includeInactive, limit })
        : archive.recall({ query, limit })
      return Promise.resolve({ memories })
    },
    presentCall: args => ({ card: 'generic', title: 'Review companion memory', kind: 'search', rawInput: args }),
  }))

  ctx.tools.register(defineTool({
    name: 'memory_forget',
    description: 'Forget one companion memory only when the owner clearly asks. The value stops being recalled, '
      + 'while an append-only audit event keeps the action recoverable.',
    parameters: {
      memoryId: { type: 'string', required: true, description: 'Exact memory id returned by memory_list.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { memory: { ...memoryValueSchema, required: true } },
      },
      render: (_args, result) => [{ type: 'text', text: `Forgot companion memory ${result.memory.id}.` }],
    },
    async execute(args, exec) {
      return {
        memory: await archive.forget({
          memoryId: args.memoryId,
          sourceMessageId: toolSourceMessageId(exec.callId, exec.agent?.id),
        }),
      }
    },
    presentCall: args => ({ card: 'generic', title: 'Forget companion memory', kind: 'delete', rawInput: args }),
  }))

  ctx.tools.register(defineTool({
    name: 'memory_replace',
    description: 'Correct one companion memory only when the owner clearly supplies the replacement. '
      + 'The previous value stops being recalled and remains in append-only audit history.',
    parameters: {
      memoryId: { type: 'string', required: true, description: 'Exact memory id returned by memory_list.' },
      content: { type: 'string', required: true, description: 'Complete corrected memory content.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { memory: { ...memoryValueSchema, required: true } },
      },
      render: (_args, result) => [{ type: 'text', text: `Replaced companion memory ${result.memory.supersedesMemoryId ?? ''}.` }],
    },
    async execute(args, exec) {
      return {
        memory: await archive.replace({
          memoryId: args.memoryId,
          content: args.content,
          sourceMessageId: toolSourceMessageId(exec.callId, exec.agent?.id),
        }),
      }
    },
    presentCall: args => ({ card: 'generic', title: 'Correct companion memory', kind: 'edit', rawInput: args }),
  }))
}

/**
 * Observe explicit owner memories and append recalled context through DSH's logged pre-step path.
 * @param ctx - Plugin context with the agent event registry.
 * @param config - Private archive path and recall limit.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const recallLimit = config.recallLimit ?? DEFAULT_RECALL_LIMIT
  if (!Number.isSafeInteger(recallLimit) || recallLimit < 1 || recallLimit > 20) {
    throw new TypeError(`mistymoon-memory: recallLimit must be an integer from 1 through 20, got ${String(recallLimit)}`)
  }
  const maxArchiveBytes = config.maxArchiveBytes ?? 67_108_864
  const maxTransactionBytes = config.maxTransactionBytes ?? 1_048_576
  if (maxTransactionBytes > maxArchiveBytes) {
    throw new TypeError('mistymoon-memory: maxTransactionBytes must not exceed maxArchiveBytes')
  }
  const archive = await openMemoryArchive({
    path: config.path,
    leaseTimeoutMs: config.leaseTimeoutMs ?? 30_000,
    leaseStaleMs: config.leaseStaleMs ?? 120_000,
    disposeTimeoutMs: config.disposeTimeoutMs ?? 5_000,
    maxArchiveBytes,
    maxTransactionBytes,
  })
  ctx.effect(() => ctx.provide('mistymoonMemory', archive), 'mistymoon-memory: shared archive')
  ctx.effect(() => () => archive.dispose(), 'mistymoon-memory: bounded archive disposal')
  ctx.effect(
    () => ctx.tools.guard((execution) => memoryOwnerGuard(ctx, execution)),
    'mistymoon-memory: Owner Eligibility tool guard',
  )
  registerMemoryTools(ctx, archive)
  ctx.on('agent/pre-step', async ({ agent }, next): Promise<PreStepDecision> => {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    const ownerMessages = ownerEligibility(ctx).ownerMessages(agent, decision.messages)
    try {
      if (archive.inspection().state !== 'ready') return decision
      for (const message of ownerMessages) {
        const text = userText(message)
        if (text !== '') await archive.observeExplicit({ sourceMessageId: message.id, text })
      }
      const query = ownerMessages.map(userText).filter(Boolean).join('\n')
      if (query === '') return decision
      const effectiveRecallLimit = config.settingsPath === undefined
        ? recallLimit
        : (await loadMemoryRuntimeSettings(config.settingsPath, recallLimit)).recallLimit
      const memories = archive.recall({ query, limit: effectiveRecallLimit })
      if (memories.length === 0) return decision
      const text = recallSnapshot(memories)
      return {
        kind: 'enter',
        messages: [
          ...decision.messages,
          createUserMessage({
            content: [{ type: 'text', text }],
            source: {
              kind: 'plugin',
              plugin: name,
              form: 'snapshot',
              sections: [{ name: 'memory:recall', text }],
            },
          }),
        ],
      }
    } catch {
      // Memory augmentation is optional for the current DSH turn. Governance
      // commands still surface failures, while the Agent Loop continues without recall.
      return decision
    }
  }, { prepend: true })
}
