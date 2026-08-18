import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { getOrCreateAnonymousUserId } from '@deepseek-ai/dsh-anonymous-user-id'
import {
  createUserMessage,
  LlmRuntime,
  ReasoningEffortId,
  type StreamChunk,
  type LlmFailure,
  type TokenUsage,
} from '@deepseek-ai/dsh-llm'
import { DeepSeekAdapter, resolveAdapterOptions } from '@deepseek-ai/dsh-llm-deepseek'

interface QualificationTask {
  readonly id: string
  readonly prompt: string
  readonly rubric: readonly RegExp[]
  readonly requiredScore: number
}

interface QualificationResult {
  readonly model: string
  readonly task: string
  readonly repetition: number
  readonly passed: boolean
  readonly validJson: boolean
  readonly rubricScore: number
  readonly rubricTotal: number
  readonly latencyMs: number
  readonly usage?: TokenUsage
  readonly responseSha256: string
  readonly finish: string
  readonly failure?: {
    readonly code: string
    readonly status?: number
    readonly messageSha256: string
  }
}

interface QualificationProgress {
  readonly event: 'qualification-case-start' | 'qualification-case-end'
  readonly model: string
  readonly task: string
  readonly repetition: number
  readonly ordinal: number
  readonly total: number
  readonly passed?: boolean
  readonly finish?: string
  readonly latencyMs?: number
}

const TASKS: readonly QualificationTask[] = [
  {
    id: 'unique-by-ordering',
    prompt: [
      'Repair this strict TypeScript function. It currently returns an empty array.',
      'Preserve first-occurrence order and do not change the signature.',
      '',
      'export function uniqueBy<T, K>(items: readonly T[], keyOf: (item: T) => K): T[] {',
      '  const seen = new Set<K>()',
      '  const result: T[] = []',
      '  for (const item of items) {',
      '    const key = keyOf(item)',
      '    seen.add(key)',
      '    if (!seen.has(key)) result.push(item)',
      '  }',
      '  return result',
      '}',
      '',
      'Return only JSON with string fields summary and patch, plus a tests string array.',
    ].join('\n'),
    rubric: [
      /if\s*\(\s*!seen\.has\(key\)\s*\)/,
      /result\.push\(item\)/,
      /seen\.add\(key\)/,
      /first|order|duplicate/i,
    ],
    requiredScore: 3,
  },
  {
    id: 'keyed-lease-release',
    prompt: [
      'Repair this keyed async lease. An older release must never delete a newer lease.',
      'Keep acquisition serialized per key and cleanup exception-safe.',
      '',
      'const active = new Map<string, Promise<void>>()',
      'export async function withKey<T>(key: string, work: () => Promise<T>): Promise<T> {',
      '  const previous = active.get(key) ?? Promise.resolve()',
      '  let release!: () => void',
      '  const current = new Promise<void>(resolve => { release = resolve })',
      '  active.set(key, previous.then(() => current))',
      '  await previous',
      '  try { return await work() } finally {',
      '    release()',
      '    active.delete(key)',
      '  }',
      '}',
      '',
      'Return only JSON with string fields summary and patch, plus a tests string array.',
    ].join('\n'),
    rubric: [
      /finally/,
      /active\.get\(key\)/,
      /===|Object\.is/,
      /active\.delete\(key\)/,
    ],
    requiredScore: 4,
  },
  {
    id: 'path-containment',
    prompt: [
      'Repair this cross-platform path authorization check. Prefix comparison is unsafe',
      'for sibling paths and mixed separators. The result must allow the root itself and',
      'descendants only, using Node path primitives.',
      '',
      "import { resolve } from 'node:path'",
      'export function isInside(root: string, candidate: string): boolean {',
      '  return resolve(candidate).startsWith(resolve(root))',
      '}',
      '',
      'Return only JSON with string fields summary and patch, plus a tests string array.',
    ].join('\n'),
    rubric: [
      /relative\s*\(/,
      /isAbsolute\s*\(/,
      /\.\.[\\/]|startsWith\([^)]*\.\./,
      /root itself|empty|===\s*['"]{2}/i,
    ],
    requiredScore: 4,
  },
]

const ALL_MODELS = ['deepseek-v4-flash', 'deepseek-v4-pro'] as const

function positiveIntegerEnv(name: string, fallback: number, maximum: number): number {
  const raw = process.env[name]
  if (raw === undefined) return fallback
  const parsed = Number(raw)
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new Error(`${name} must be an integer between 1 and ${maximum}`)
  }
  return parsed
}

function selectedModels(): readonly (typeof ALL_MODELS)[number][] {
  const raw = process.env.MISTYMOON_QUAL_MODELS
  if (raw === undefined) return ALL_MODELS
  const selected = raw.split(',').map(value => value.trim()).filter(Boolean)
  if (selected.length === 0 || selected.some(value => !ALL_MODELS.includes(value as never))) {
    throw new Error(`MISTYMOON_QUAL_MODELS must contain only ${ALL_MODELS.join(', ')}`)
  }
  return selected as (typeof ALL_MODELS)[number][]
}

const MODELS = selectedModels()
const REPETITIONS = positiveIntegerEnv('MISTYMOON_QUAL_REPETITIONS', 5, 5)
const MAX_TOKENS = positiveIntegerEnv('MISTYMOON_QUAL_MAX_TOKENS', 12000, 64000)

function progress(event: QualificationProgress): void {
  process.stderr.write(`${JSON.stringify(event)}\n`)
}

function jsonShape(text: string): boolean {
  try {
    const value = JSON.parse(text) as Record<string, unknown>
    return typeof value === 'object'
      && value !== null
      && typeof value.summary === 'string'
      && typeof value.patch === 'string'
      && Array.isArray(value.tests)
      && value.tests.every(item => typeof item === 'string')
  } catch {
    return false
  }
}

async function runOne(
  ctx: Context,
  model: string,
  task: QualificationTask,
  repetition: number,
): Promise<QualificationResult> {
  const started = performance.now()
  let text = ''
  let usage: TokenUsage | undefined
  let finish = 'missing'
  let failure: LlmFailure | undefined
  for await (const chunk of ctx.llm.stream({
    provider: 'deepseek-official',
    model,
    reasoningEffort: ReasoningEffortId('max'),
    maxTokens: MAX_TOKENS,
    system: 'You are a neutral governed software engineering evaluator. Follow the requested output schema exactly.',
    messages: [createUserMessage({
      content: [{ type: 'text', text: task.prompt }],
      source: { kind: 'user' },
    })],
    signal: new AbortController().signal,
  })) {
    const typed: StreamChunk = chunk
    if (typed.type === 'text-delta') text += typed.text
    if (typed.type === 'usage') usage = typed.usage
    if (typed.type === 'finish') {
      finish = typed.reason.kind
      if (typed.reason.kind === 'error' || typed.reason.kind === 'aborted') {
        failure = typed.reason.failure
      }
    }
  }
  const validJson = jsonShape(text)
  const rubricScore = task.rubric.filter(rule => rule.test(text)).length
  return {
    model,
    task: task.id,
    repetition,
    passed: finish === 'stop' && validJson && rubricScore >= task.requiredScore,
    validJson,
    rubricScore,
    rubricTotal: task.rubric.length,
    latencyMs: Math.round(performance.now() - started),
    ...(usage === undefined ? {} : { usage }),
    responseSha256: createHash('sha256').update(text).digest('hex'),
    finish,
    ...(failure === undefined ? {} : {
      failure: {
        code: failure.code,
        ...(failure.status === undefined ? {} : { status: failure.status }),
        messageSha256: createHash('sha256').update(failure.message).digest('hex'),
      },
    }),
  }
}

async function main(): Promise<void> {
  if (process.env.DEEPSEEK_API_KEY?.trim() === '') delete process.env.DEEPSEEK_API_KEY
  if (process.env.DEEPSEEK_API_KEY === undefined) {
    throw new Error('DEEPSEEK_API_KEY is unavailable in this qualification process')
  }
  const dshHome = await mkdtemp(join(tmpdir(), 'mistymoon-model-qualification-'))
  const ctx = new Context()
  const fiber = ctx.plugin(LlmRuntime)
  await fiber
  const connection = resolveAdapterOptions({
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    thinking: 'enabled',
    reasoningEffort: 'max',
    maxTokens: MAX_TOKENS,
  })
  const adapter = new DeepSeekAdapter({
    options: () => connection,
    resolveApiKey: async () => process.env.DEEPSEEK_API_KEY!,
    resolveUserId: () => getOrCreateAnonymousUserId({
      env: { DSH_HOME: dshHome },
      randomUUID: () => '00000000-0000-4000-8000-000000000018',
    }),
  })
  const unregister = ctx.llm.registerAdapter(['deepseek-official'], adapter)
  const results: QualificationResult[] = []
  const total = MODELS.length * TASKS.length * REPETITIONS
  let ordinal = 0
  try {
    for (const model of MODELS) {
      for (const task of TASKS) {
        for (let repetition = 1; repetition <= REPETITIONS; repetition++) {
          ordinal++
          progress({
            event: 'qualification-case-start',
            model,
            task: task.id,
            repetition,
            ordinal,
            total,
          })
          const result = await runOne(ctx, model, task, repetition)
          results.push(result)
          progress({
            event: 'qualification-case-end',
            model,
            task: task.id,
            repetition,
            ordinal,
            total,
            passed: result.passed,
            finish: result.finish,
            latencyMs: result.latencyMs,
          })
        }
      }
    }
  } finally {
    unregister()
    await fiber.dispose()
    await rm(dshHome, { recursive: true, force: true })
  }
  const passed = results.every(result => result.passed)
  process.stdout.write(`${JSON.stringify({
    version: 1,
    route: { provider: 'deepseek-official', reasoning: 'max' },
    repetitions: REPETITIONS,
    maxTokens: MAX_TOKENS,
    passed,
    results,
  }, null, 2)}\n`)
  if (!passed) process.exitCode = 1
}

await main()
