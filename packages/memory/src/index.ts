/**
 * Durable companion memory for MistyMoon on DSH.
 * @module @mistymoon/dsh-memory
 */

import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import { defineTool, type ValueSchemaSpec } from '@deepseek-ai/dsh-tools'
import { DEFAULT_RECALL_LIMIT, loadMemoryRuntimeSettings } from './runtime-settings.js'

export * from './runtime-settings.js'

/** Cordis plugin name and durable user-message source id. */
export const name = 'mistymoon-memory'

/** Agent pre-step waterfall used for durable memory projection. */
export const inject = ['agents', 'tools']

/** Memory plugin configuration. */
export interface Config {
  /** Private append-only JSONL path. */
  path: string
  /** Maximum memories included in one model-visible snapshot. */
  recallLimit?: number
  /** Optional private owner settings document read before each recall. */
  settingsPath?: string
}

/** Runtime schema for the memory plugin. */
export const Config: z<Config> = z.object({
  path: z.string().required(),
  recallLimit: z.number().step(1).min(1).max(20).default(DEFAULT_RECALL_LIMIT),
  settingsPath: z.string(),
})

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
  supersedesMemoryId?: string
  status: 'confirmed' | 'forgotten' | 'superseded'
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
}

/** Construction inputs for a private memory archive. */
export interface OpenMemoryArchiveOptions {
  path: string
  createId?: () => string
  now?: () => Date
}

function object(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${path} must be an object`)
  return value as Record<string, unknown>
}

function string(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${path} must be a non-empty string`)
  return value
}

interface MemoryForgottenEvent {
  schemaVersion: 1
  event: 'forgotten'
  id: string
  createdAt: string
  memoryId: string
  sourceMessageId: string
}

type MemoryLogEntry = MemoryRecord | MemoryForgottenEvent

function parseRecord(value: Record<string, unknown>, line: number): MemoryRecord {
  const record = value
  if (record.schemaVersion !== 1) throw new Error(`memory line ${line}.schemaVersion must equal 1`)
  if (record.status !== 'confirmed') throw new Error(`memory line ${line}.status must equal "confirmed"`)
  if (record.visibility !== 'personal' && record.visibility !== 'confidential') {
    throw new Error(`memory line ${line}.visibility is unsupported`)
  }
  return {
    schemaVersion: 1,
    id: string(record.id, `memory line ${line}.id`),
    createdAt: string(record.createdAt, `memory line ${line}.createdAt`),
    content: string(record.content, `memory line ${line}.content`),
    visibility: record.visibility,
    sourceMessageId: string(record.sourceMessageId, `memory line ${line}.sourceMessageId`),
    ...(record.supersedesMemoryId === undefined
      ? {}
      : { supersedesMemoryId: string(record.supersedesMemoryId, `memory line ${line}.supersedesMemoryId`) }),
    status: 'confirmed',
  }
}

function parseEntry(value: unknown, line: number): MemoryLogEntry {
  const entry = object(value, `memory line ${line}`)
  if (entry.event === 'forgotten') {
    if (entry.schemaVersion !== 1) throw new Error(`memory line ${line}.schemaVersion must equal 1`)
    return {
      schemaVersion: 1,
      event: 'forgotten',
      id: string(entry.id, `memory line ${line}.id`),
      createdAt: string(entry.createdAt, `memory line ${line}.createdAt`),
      memoryId: string(entry.memoryId, `memory line ${line}.memoryId`),
      sourceMessageId: string(entry.sourceMessageId, `memory line ${line}.sourceMessageId`),
    }
  }
  return parseRecord(entry, line)
}

async function loadEntries(path: string): Promise<MemoryLogEntry[]> {
  let source: string
  try {
    source = await readFile(path, 'utf8')
  } catch (error) {
    if (error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  return source.split(/\r?\n/u).flatMap((line, index) => {
    if (line.trim() === '') return []
    try {
      return [parseEntry(JSON.parse(line) as unknown, index + 1)]
    } catch (error) {
      throw new Error(`failed to load ${path}: ${error instanceof Error ? error.message : String(error)}`)
    }
  })
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

class JsonlMemoryArchive implements CompanionMemoryArchive {
  readonly #byMessage = new Map<string, MemoryRecord>()
  readonly #byId = new Map<string, MemoryRecord>()
  readonly #records: MemoryRecord[]
  #writes = Promise.resolve()

  constructor(
    private readonly path: string,
    entries: MemoryLogEntry[],
    private readonly createId: () => string,
    private readonly now: () => Date,
  ) {
    this.#records = []
    for (const entry of entries) {
      if (this.#byMessage.has(entry.sourceMessageId)) {
        throw new Error(`duplicate memory sourceMessageId ${JSON.stringify(entry.sourceMessageId)}`)
      }
      if ('event' in entry) {
        const target = this.#byId.get(entry.memoryId)
        if (target === undefined) throw new Error(`forgotten event references unknown memory ${JSON.stringify(entry.memoryId)}`)
        if (target.status !== 'confirmed') throw new Error(`memory ${JSON.stringify(entry.memoryId)} is already inactive`)
        target.status = 'forgotten'
        this.#byMessage.set(entry.sourceMessageId, target)
        continue
      }
      if (this.#byId.has(entry.id)) throw new Error(`duplicate memory id ${JSON.stringify(entry.id)}`)
      if (entry.supersedesMemoryId !== undefined) {
        const target = this.#byId.get(entry.supersedesMemoryId)
        if (target === undefined) {
          throw new Error(`replacement references unknown memory ${JSON.stringify(entry.supersedesMemoryId)}`)
        }
        if (target.status !== 'confirmed') {
          throw new Error(`replacement target ${JSON.stringify(entry.supersedesMemoryId)} is already inactive`)
        }
        target.status = 'superseded'
      }
      this.#records.push(entry)
      this.#byId.set(entry.id, entry)
      this.#byMessage.set(entry.sourceMessageId, entry)
    }
  }

  async observeExplicit(input: ExplicitMemoryObservation): Promise<MemoryRecord | undefined> {
    const existing = this.#byMessage.get(input.sourceMessageId)
    if (existing !== undefined) return existing
    const content = explicitContent(input.text)
    if (content === undefined) return undefined
    const record: MemoryRecord = {
      schemaVersion: 1,
      id: this.createId(),
      createdAt: this.now().toISOString(),
      content,
      visibility: /保密|不要告诉|别告诉|不能告诉/u.test(input.text) ? 'confidential' : 'personal',
      sourceMessageId: input.sourceMessageId,
      status: 'confirmed',
    }
    this.#records.push(record)
    this.#byId.set(record.id, record)
    this.#byMessage.set(record.sourceMessageId, record)
    const write = this.#writes.then(async () => {
      await mkdir(dirname(this.path), { recursive: true })
      await appendFile(this.path, `${JSON.stringify(record)}\n`, 'utf8')
    })
    this.#writes = write.catch(() => {})
    try {
      await write
    } catch (error) {
      this.#records.pop()
      this.#byId.delete(record.id)
      this.#byMessage.delete(record.sourceMessageId)
      throw error
    }
    return record
  }

  recall(input: MemoryRecall): MemoryRecord[] {
    const limit = Math.max(0, input.limit ?? 8)
    const query = input.query.trim()
    return this.#records
      .filter(record => record.status === 'confirmed')
      .map(record => ({ record, score: query === '' ? 1 : lexicalScore(query, record.content) }))
      .filter(item => query === '' || item.score > 0)
      .sort((left, right) => right.score - left.score || right.record.createdAt.localeCompare(left.record.createdAt))
      .slice(0, limit)
      .map(item => item.record)
  }

  list(input: MemoryList = {}): MemoryRecord[] {
    const limit = Math.max(0, input.limit ?? 100)
    return this.#records
      .filter(record => input.includeInactive === true || record.status === 'confirmed')
      .map((record, index) => ({ record, index }))
      .toSorted((left, right) => right.record.createdAt.localeCompare(left.record.createdAt) || right.index - left.index)
      .slice(0, limit)
      .map(item => item.record)
  }

  async forget(input: MemoryForget): Promise<MemoryRecord> {
    const duplicate = this.#byMessage.get(input.sourceMessageId)
    if (duplicate !== undefined) return duplicate
    const record = this.#byId.get(input.memoryId)
    if (record === undefined) throw new Error(`memory ${JSON.stringify(input.memoryId)} does not exist`)
    if (record.status !== 'confirmed') throw new Error(`memory ${JSON.stringify(input.memoryId)} is already ${record.status}`)
    const event: MemoryForgottenEvent = {
      schemaVersion: 1,
      event: 'forgotten',
      id: this.createId(),
      createdAt: this.now().toISOString(),
      memoryId: record.id,
      sourceMessageId: input.sourceMessageId,
    }
    record.status = 'forgotten'
    this.#byMessage.set(input.sourceMessageId, record)
    const write = this.#writes.then(async () => {
      await mkdir(dirname(this.path), { recursive: true })
      await appendFile(this.path, `${JSON.stringify(event)}\n`, 'utf8')
    })
    this.#writes = write.catch(() => {})
    try {
      await write
    } catch (error) {
      record.status = 'confirmed'
      this.#byMessage.delete(input.sourceMessageId)
      throw error
    }
    return record
  }

  async replace(input: MemoryReplace): Promise<MemoryRecord> {
    const duplicate = this.#byMessage.get(input.sourceMessageId)
    if (duplicate !== undefined) return duplicate
    const target = this.#byId.get(input.memoryId)
    if (target === undefined) throw new Error(`memory ${JSON.stringify(input.memoryId)} does not exist`)
    if (target.status !== 'confirmed') throw new Error(`memory ${JSON.stringify(input.memoryId)} is already ${target.status}`)
    const content = input.content.trim()
    if (content === '') throw new Error('replacement memory content must be a non-empty string')
    const replacement: MemoryRecord = {
      schemaVersion: 1,
      id: this.createId(),
      createdAt: this.now().toISOString(),
      content,
      visibility: target.visibility,
      sourceMessageId: input.sourceMessageId,
      supersedesMemoryId: target.id,
      status: 'confirmed',
    }
    if (this.#byId.has(replacement.id)) throw new Error(`duplicate memory id ${JSON.stringify(replacement.id)}`)
    target.status = 'superseded'
    this.#records.push(replacement)
    this.#byId.set(replacement.id, replacement)
    this.#byMessage.set(replacement.sourceMessageId, replacement)
    const write = this.#writes.then(async () => {
      await mkdir(dirname(this.path), { recursive: true })
      await appendFile(this.path, `${JSON.stringify(replacement)}\n`, 'utf8')
    })
    this.#writes = write.catch(() => {})
    try {
      await write
    } catch (error) {
      target.status = 'confirmed'
      this.#records.pop()
      this.#byId.delete(replacement.id)
      this.#byMessage.delete(replacement.sourceMessageId)
      throw error
    }
    return replacement
  }

  async importConfirmed(input: ConfirmedMemoryImport): Promise<ConfirmedMemoryImportResult> {
    const duplicate = this.#byMessage.get(input.sourceMessageId)
    if (duplicate !== undefined) return { memory: duplicate, imported: false }
    const content = input.content.trim()
    if (content === '') throw new Error('imported memory content must be a non-empty string')
    const createdAt = new Date(input.createdAt)
    if (Number.isNaN(createdAt.getTime())) throw new Error(`invalid imported memory timestamp ${JSON.stringify(input.createdAt)}`)
    const record: MemoryRecord = {
      schemaVersion: 1,
      id: this.createId(),
      createdAt: createdAt.toISOString(),
      content,
      visibility: input.visibility,
      sourceMessageId: input.sourceMessageId,
      status: 'confirmed',
    }
    if (this.#byId.has(record.id)) throw new Error(`duplicate memory id ${JSON.stringify(record.id)}`)
    this.#records.push(record)
    this.#byId.set(record.id, record)
    this.#byMessage.set(record.sourceMessageId, record)
    const write = this.#writes.then(async () => {
      await mkdir(dirname(this.path), { recursive: true })
      await appendFile(this.path, `${JSON.stringify(record)}\n`, 'utf8')
    })
    this.#writes = write.catch(() => {})
    try {
      await write
    } catch (error) {
      this.#records.pop()
      this.#byId.delete(record.id)
      this.#byMessage.delete(record.sourceMessageId)
      throw error
    }
    return { memory: record, imported: true }
  }
}

/**
 * Open a private append-only memory archive, validating every existing record.
 * @param options - File location and optional deterministic construction hooks.
 * @returns Archive ready for explicit observation and recall.
 */
export async function openMemoryArchive(options: OpenMemoryArchiveOptions): Promise<CompanionMemoryArchive> {
  const records = await loadEntries(options.path)
  return new JsonlMemoryArchive(
    options.path,
    records,
    options.createId ?? randomUUID,
    options.now ?? (() => new Date()),
  )
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
    supersedesMemoryId: { type: 'string' },
    status: { type: 'string', required: true, enum: ['confirmed', 'forgotten', 'superseded'] },
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

function registerMemoryTools(ctx: Context, archive: CompanionMemoryArchive): void {
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
  const archive = await openMemoryArchive({ path: config.path })
  registerMemoryTools(ctx, archive)
  ctx.on('agent/pre-step', async (_payload, next): Promise<PreStepDecision> => {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    const ownerMessages = decision.messages.filter(message => message.source.kind === 'user')
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
  }, { prepend: true })
}
