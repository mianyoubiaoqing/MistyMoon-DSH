import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/** Exact DSH provider/model selection persisted without credentials or endpoint data. */
export interface WorkModelRouteSettingsV1 {
  readonly version: 1
  readonly revision: number
  readonly provider: string
  readonly model: string
  readonly reasoning: 'max'
  readonly qualification: 'qualified-direct' | 'experimental-owner-configured'
}

/** Credential-free model option projected from the live DSH provider registry. */
export interface WorkModelCatalogEntryV1 {
  readonly provider: string
  readonly providerName: string
  readonly model: string
  readonly modelName: string
  readonly description?: string
  readonly qualification: 'qualified-direct' | 'experimental-owner-configured'
}

/** Owner-authored request to set the default for future fresh Work activations. */
export interface ConfigureWorkModelRouteRequestV1 {
  readonly version: 1
  readonly expectedRevision: number
  readonly provider: string
  readonly model: string
  readonly ownerConfirmed: boolean
}

export const DEFAULT_WORK_MODEL_ROUTE: WorkModelRouteSettingsV1 = Object.freeze({
  version: 1,
  revision: 1,
  provider: 'deepseek-official',
  model: 'deepseek-v4-flash',
  reasoning: 'max',
  qualification: 'qualified-direct',
})

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

function parse(value: unknown): WorkModelRouteSettingsV1 {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('mistymoon-work-agent: Work model settings must be an object')
  }
  const input = value as Record<string, unknown>
  const keys = Object.keys(input).toSorted()
  const expected = ['model', 'provider', 'qualification', 'reasoning', 'revision', 'version']
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new TypeError('mistymoon-work-agent: Work model settings contain unknown or missing fields')
  }
  if (input.version !== 1
    || !Number.isSafeInteger(input.revision)
    || (input.revision as number) < 1
    || !nonEmptyString(input.provider)
    || !nonEmptyString(input.model)
    || input.reasoning !== 'max'
    || (input.qualification !== 'qualified-direct'
      && input.qualification !== 'experimental-owner-configured')) {
    throw new TypeError('mistymoon-work-agent: Work model settings are invalid')
  }
  const direct = input.provider === DEFAULT_WORK_MODEL_ROUTE.provider
    && input.model === DEFAULT_WORK_MODEL_ROUTE.model
  if (direct !== (input.qualification === 'qualified-direct')) {
    throw new TypeError('mistymoon-work-agent: Work model qualification does not match the exact route')
  }
  return Object.freeze({
    version: 1,
    revision: input.revision as number,
    provider: input.provider.trim(),
    model: input.model.trim(),
    reasoning: 'max',
    qualification: input.qualification,
  })
}

/** Load a versioned Work model selection, defaulting only when no file exists. */
export async function loadWorkModelRouteSettings(path: string): Promise<WorkModelRouteSettingsV1> {
  try {
    return parse(JSON.parse(await readFile(path, 'utf8')))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return DEFAULT_WORK_MODEL_ROUTE
    if (error instanceof SyntaxError) {
      throw new TypeError('mistymoon-work-agent: Work model settings JSON is malformed', { cause: error })
    }
    throw error
  }
}

/** Atomically persist one already validated, credential-free Work model selection. */
export async function saveWorkModelRouteSettings(
  path: string,
  settings: WorkModelRouteSettingsV1,
): Promise<void> {
  const validated = parse(settings)
  await mkdir(dirname(path), { recursive: true })
  const staging = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(staging, `${JSON.stringify(validated, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
    await rename(staging, path)
  } finally {
    await rm(staging, { force: true })
  }
}
