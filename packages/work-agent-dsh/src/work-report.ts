import type {
  ResolvedSubagentStartRequest,
  SubagentProvider,
  SubagentResult,
} from '@deepseek-ai/dsh-subagent'
import type {
  WorkReportArtifactV1,
  WorkReportCheckV1,
  WorkReportV1,
} from '@mistymoon/dsh/work-agent'

const MAX_REPORT_LENGTH = 262_144
const MAX_LIST_LENGTH = 128
const MAX_SHORT_TEXT_LENGTH = 2_048
const MAX_SUMMARY_LENGTH = 8_192
const MAX_ARTIFACT_LENGTH = 65_536

const REPORT_KEYS = [
  'version',
  'status',
  'summary',
  'changedFiles',
  'checksRun',
  'risks',
  'needsUserAction',
  'artifacts',
] as const

const CHECK_KEYS = ['command', 'status', 'summary'] as const
const ARTIFACT_KEYS = ['kind', 'label', 'content'] as const
const REPORT_STATUSES = new Set(['completed', 'blocked', 'failed'])
const CHECK_STATUSES = new Set(['passed', 'failed', 'not-run'])
const ARTIFACT_KINDS = new Set(['text', 'code', 'patch', 'command-output', 'citation'])

export const WORK_REPORT_INSTRUCTION = [
  'Return exactly one text block containing a WorkReportV1 JSON object; do not use Markdown fences or surrounding prose.',
  'The object must contain exactly these fields:',
  '{"version":1,"status":"completed|blocked|failed","summary":"string","changedFiles":["string"],"checksRun":[{"command":"string","status":"passed|failed|not-run","summary":"string"}],"risks":["string"],"needsUserAction":["string"],"artifacts":[{"kind":"text|code|patch|command-output|citation","label":"string","content":"string"}]}',
  'Use empty arrays when a category has no entries. Preserve commands, paths, numerical results, citations, risks, and artifact content exactly.',
].join('\n')

/** Stable failure for an untrusted model response that is not WorkReportV1. */
export class WorkReportValidationError extends Error {
  constructor() {
    super('work-agent-dsh: invalid WorkReportV1 envelope')
    this.name = 'WorkReportValidationError'
  }
}

function invalid(): never {
  throw new WorkReportValidationError()
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) invalid()
  return value as Record<string, unknown>
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(value)
  if (actual.length !== expected.length || actual.some(key => !expected.includes(key))) invalid()
}

function boundedString(value: unknown, maximum: number, allowEmpty = false): string {
  if (typeof value !== 'string' || value.length > maximum || (!allowEmpty && value.trim() === '')) invalid()
  return value
}

function stringList(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length > MAX_LIST_LENGTH) invalid()
  return Object.freeze(value.map(item => boundedString(item, MAX_SHORT_TEXT_LENGTH)))
}

function check(value: unknown): WorkReportCheckV1 {
  const input = record(value)
  exactKeys(input, CHECK_KEYS)
  if (typeof input.status !== 'string' || !CHECK_STATUSES.has(input.status)) invalid()
  return Object.freeze({
    command: boundedString(input.command, MAX_SHORT_TEXT_LENGTH),
    status: input.status as WorkReportCheckV1['status'],
    summary: boundedString(input.summary, MAX_SHORT_TEXT_LENGTH),
  })
}

function artifact(value: unknown): WorkReportArtifactV1 {
  const input = record(value)
  exactKeys(input, ARTIFACT_KEYS)
  if (typeof input.kind !== 'string' || !ARTIFACT_KINDS.has(input.kind)) invalid()
  return Object.freeze({
    kind: input.kind as WorkReportArtifactV1['kind'],
    label: boundedString(input.label, MAX_SHORT_TEXT_LENGTH),
    content: boundedString(input.content, MAX_ARTIFACT_LENGTH, true),
  })
}

function mappedList<T>(value: unknown, mapper: (item: unknown) => T): readonly T[] {
  if (!Array.isArray(value) || value.length > MAX_LIST_LENGTH) invalid()
  return Object.freeze(value.map(mapper))
}

/** Parse the strict, versioned JSON envelope emitted by a Work child. */
export function parseWorkReportV1(text: string): WorkReportV1 {
  if (text.length === 0 || text.length > MAX_REPORT_LENGTH) invalid()
  const trimmed = text.trim()
  if (trimmed.length === 0 || trimmed.length > MAX_REPORT_LENGTH) invalid()
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    invalid()
  }
  const input = record(parsed)
  exactKeys(input, REPORT_KEYS)
  if (input.version !== 1 || typeof input.status !== 'string' || !REPORT_STATUSES.has(input.status)) invalid()
  return Object.freeze({
    version: 1,
    status: input.status as WorkReportV1['status'],
    summary: boundedString(input.summary, MAX_SUMMARY_LENGTH),
    changedFiles: stringList(input.changedFiles),
    checksRun: mappedList(input.checksRun, check),
    risks: stringList(input.risks),
    needsUserAction: stringList(input.needsUserAction),
    artifacts: mappedList(input.artifacts, artifact),
  })
}

function reportText(result: SubagentResult): string {
  const textBlocks = result.output.filter(block => block.type === 'text')
  if (textBlocks.length !== 1) invalid()
  if (result.output.some(block => block.type !== 'text' && block.type !== 'reasoning')) invalid()
  return textBlocks[0]!.text
}

function withoutReasoning(result: SubagentResult): SubagentResult {
  if (!result.output.some(block => block.type === 'reasoning')) return result
  return {
    ...result,
    output: result.output.filter(block => block.type !== 'reasoning'),
  }
}

function validatedResult(result: SubagentResult): SubagentResult {
  const publishable = withoutReasoning(result)
  if (publishable.stopReason !== 'completed') return publishable
  try {
    const text = reportText(publishable)
    const report = parseWorkReportV1(text)
    return {
      ...publishable,
      output: [{ type: 'text', text }],
      structured: report,
    }
  } catch (error) {
    if (!(error instanceof WorkReportValidationError)) throw error
    return {
      output: [{ type: 'text', text: 'Work Agent report rejected: invalid WorkReportV1 envelope.' }],
      stopReason: 'error',
    }
  }
}

/** Add the model-visible report contract and validate the completed run boundary. */
export function createWorkReportProvider(delegate: SubagentProvider): SubagentProvider {
  return Object.freeze({
    ...delegate,
    async start(request: ResolvedSubagentStartRequest) {
      const governedRequest: ResolvedSubagentStartRequest = {
        ...request,
        prompt: [...request.prompt, { type: 'text', text: WORK_REPORT_INSTRUCTION }],
      }
      const run = await delegate.start(governedRequest)
      return {
        ...run,
        result: run.result.then(validatedResult),
      }
    },
  })
}
