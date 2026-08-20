import { createHash, randomUUID } from 'node:crypto'
import {
  cp,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
} from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'

const PRESET_ID = /^[a-z0-9][a-z0-9-]*$/

/** User-confirmed provision operation supported by the standalone installer seam. */
export type WorkPresetProvisionActionV1 = 'install' | 'upgrade' | 'rollback'

/** Inputs for a read-only Work preset provision preview. */
export interface PreviewWorkPresetProvisionV1 {
  readonly version: 1
  readonly action: WorkPresetProvisionActionV1
  readonly dshHome: string
  readonly sourceDirectory: string
  readonly nativePresetId: string
  readonly currentNativePresetId?: string
}

/** Non-sensitive relative change shown to the Owner before applying a plan. */
export interface WorkPresetProvisionChangeV1 {
  readonly kind: 'create' | 'retain'
  readonly path: string
}

/** Relative, content-free file difference shown for upgrade and rollback review. */
export interface WorkPresetFileDifferenceV1 {
  readonly kind: 'added' | 'modified' | 'removed'
  readonly path: string
}

/** Immutable preview whose private paths stay inside the provisioner boundary. */
export interface WorkPresetProvisionPlanV1 {
  readonly version: 1
  readonly action: WorkPresetProvisionActionV1
  readonly status: 'ready' | 'target-exists'
  readonly nativePresetId: string
  readonly requiresOwnerConfirmation: true
  readonly sourceFingerprint: string
  readonly changes: readonly WorkPresetProvisionChangeV1[]
  readonly fileDifferences: readonly WorkPresetFileDifferenceV1[]
  readonly sourceDirectory: string
  readonly targetDirectory: string
  readonly currentDirectory?: string
}

/** Stable reason for a provision refusal without exposing file contents. */
export type WorkPresetProvisionReasonV1 =
  | 'confirmation-required'
  | 'current-missing'
  | 'invalid-input'
  | 'profile-conflict'
  | 'source-changed'
  | 'target-exists'
  | 'unsafe-source'

/** Fail-loud error returned by the standalone provision transaction. */
export class WorkPresetProvisionError extends Error {
  constructor(readonly reason: WorkPresetProvisionReasonV1, message: string) {
    super(message)
    this.name = 'WorkPresetProvisionError'
  }
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value
  for (const child of Object.values(value)) deepFreeze(child)
  return Object.freeze(value)
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

async function directoryFileHashes(root: string): Promise<Map<string, string>> {
  const files: string[] = []

  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true })
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      const path = join(directory, entry.name)
      if (entry.isSymbolicLink()) {
        throw new WorkPresetProvisionError('unsafe-source', 'Work preset sources may not contain symbolic links.')
      }
      if (entry.isDirectory()) {
        await visit(path)
      } else if (entry.isFile()) {
        files.push(path)
      } else {
        throw new WorkPresetProvisionError('unsafe-source', 'Work preset sources may contain only files and directories.')
      }
    }
  }

  const rootStat = await lstat(root)
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new WorkPresetProvisionError('unsafe-source', 'Work preset source must be a real directory.')
  }
  await visit(root)
  const hashes = new Map<string, string>()
  for (const path of files) {
    const relativePath = relative(root, path).split(sep).join('/')
    hashes.set(relativePath, createHash('sha256').update(await readFile(path)).digest('hex'))
  }
  return hashes
}

async function fingerprintDirectory(root: string): Promise<string> {
  const files = await directoryFileHashes(root)
  const hash = createHash('sha256')
  for (const [relativePath, contentHash] of [...files].sort(([left], [right]) => left.localeCompare(right))) {
    hash.update(relativePath, 'utf8').update('\0').update(contentHash, 'ascii').update('\n')
  }
  return hash.digest('hex')
}

function fileDifferences(
  current: ReadonlyMap<string, string>,
  target: ReadonlyMap<string, string>,
): WorkPresetFileDifferenceV1[] {
  const paths = [...new Set([...current.keys(), ...target.keys()])].sort((left, right) => left.localeCompare(right))
  return paths.flatMap((path): WorkPresetFileDifferenceV1[] => {
    const before = current.get(path)
    const after = target.get(path)
    if (before === undefined) return [{ kind: 'added', path }]
    if (after === undefined) return [{ kind: 'removed', path }]
    if (before !== after) return [{ kind: 'modified', path }]
    return []
  })
}

function normalizedInputs(input: PreviewWorkPresetProvisionV1): {
  sourceDirectory: string
  targetDirectory: string
  currentDirectory?: string
} {
  if (input.version !== 1 || !PRESET_ID.test(input.nativePresetId)) {
    throw new WorkPresetProvisionError('invalid-input', 'Work preset provision input is invalid.')
  }
  if (input.action !== 'install' && input.action !== 'upgrade' && input.action !== 'rollback') {
    throw new WorkPresetProvisionError('invalid-input', 'Work preset provision action is invalid.')
  }
  const sourceDirectory = resolve(input.sourceDirectory)
  const presetRoot = join(resolve(input.dshHome), '.agent-presets')
  const targetDirectory = join(presetRoot, input.nativePresetId)
  if (sourceDirectory === targetDirectory
    || sourceDirectory.startsWith(`${targetDirectory}${sep}`)
    || targetDirectory.startsWith(`${sourceDirectory}${sep}`)) {
    throw new WorkPresetProvisionError('invalid-input', 'Work preset source and target must be independent.')
  }
  if (input.action === 'install') return { sourceDirectory, targetDirectory }
  if (input.currentNativePresetId === undefined
    || !PRESET_ID.test(input.currentNativePresetId)
    || input.currentNativePresetId === input.nativePresetId) {
    throw new WorkPresetProvisionError('invalid-input', 'Versioned upgrade and rollback require a distinct current preset id.')
  }
  return {
    sourceDirectory,
    targetDirectory,
    currentDirectory: join(presetRoot, input.currentNativePresetId),
  }
}

/** Creates a read-only, Owner-reviewable plan without modifying the DSH Home. */
export async function previewWorkPresetProvision(
  input: PreviewWorkPresetProvisionV1,
): Promise<WorkPresetProvisionPlanV1> {
  const { sourceDirectory, targetDirectory, currentDirectory } = normalizedInputs(input)
  const sourceFingerprint = await fingerprintDirectory(sourceDirectory)
  const targetExists = await exists(targetDirectory)
  if (currentDirectory !== undefined && !(await exists(currentDirectory))) {
    throw new WorkPresetProvisionError('current-missing', 'Current Work preset does not exist for preview.')
  }
  const differences = currentDirectory === undefined
    ? []
    : fileDifferences(
        await directoryFileHashes(currentDirectory),
        await directoryFileHashes(sourceDirectory),
      )
  const changes: WorkPresetProvisionChangeV1[] = targetExists
    ? []
    : [
        ...(input.currentNativePresetId === undefined
          ? []
          : [{ kind: 'retain' as const, path: input.currentNativePresetId }]),
        { kind: 'create', path: input.nativePresetId },
      ]
  return deepFreeze({
    version: 1,
    action: input.action,
    status: targetExists ? 'target-exists' : 'ready',
    nativePresetId: input.nativePresetId,
    requiresOwnerConfirmation: true,
    sourceFingerprint,
    changes,
    fileDifferences: differences,
    sourceDirectory,
    targetDirectory,
    ...(currentDirectory === undefined ? {} : { currentDirectory }),
  })
}

/** Applies one unchanged preview through a staging directory after Owner confirmation. */
export async function applyWorkPresetProvision(
  plan: WorkPresetProvisionPlanV1,
  options: { readonly ownerConfirmed: boolean },
): Promise<void> {
  if (!options.ownerConfirmed) {
    throw new WorkPresetProvisionError('confirmation-required', 'Owner confirmation is required to provision a Work preset.')
  }
  if (plan.status !== 'ready') {
    throw new WorkPresetProvisionError('target-exists', 'Work preset target already exists and will not be overwritten.')
  }
  if (await fingerprintDirectory(plan.sourceDirectory) !== plan.sourceFingerprint) {
    throw new WorkPresetProvisionError('source-changed', 'Work preset source changed after preview.')
  }

  const targetParent = resolve(plan.targetDirectory, '..')
  await mkdir(targetParent, { recursive: true })
  const stagingDirectory = join(targetParent, `.${plan.nativePresetId}.staging-${randomUUID()}`)
  const lockPath = join(targetParent, `.${plan.nativePresetId}.provision.lock`)
  let lock: Awaited<ReturnType<typeof open>> | undefined
  try {
    lock = await open(lockPath, 'wx')
    if (await exists(plan.targetDirectory)) {
      throw new WorkPresetProvisionError('target-exists', 'Work preset target appeared after preview and will not be overwritten.')
    }
    await cp(plan.sourceDirectory, stagingDirectory, {
      recursive: true,
      errorOnExist: true,
      force: false,
    })
    if (await fingerprintDirectory(stagingDirectory) !== plan.sourceFingerprint) {
      throw new WorkPresetProvisionError('source-changed', 'Staged Work preset does not match its preview.')
    }
    await rename(stagingDirectory, plan.targetDirectory)
  } finally {
    await rm(stagingDirectory, { recursive: true, force: true })
    if (lock) {
      await lock.close()
      await rm(lockPath, { force: true })
    }
  }
}

/** Compute the content-only fingerprint used by installer state and drift checks. */
export function fingerprintAgentPresetDirectory(root: string): Promise<string> {
  return fingerprintDirectory(root)
}

/**
 * Remove only an unchanged target created by a failed surrounding install.
 * This compensates an incomplete transaction; it is not a user-facing
 * uninstall operation.
 */
export async function compensateWorkPresetProvision(
  plan: WorkPresetProvisionPlanV1,
): Promise<void> {
  if (!(await exists(plan.targetDirectory))) return
  if (await fingerprintDirectory(plan.targetDirectory) !== plan.sourceFingerprint) {
    throw new WorkPresetProvisionError(
      'source-changed',
      'Provisioned Work preset changed before failed-install compensation.',
    )
  }
  await rm(plan.targetDirectory, { recursive: true, force: false })
}

/** Generic preset provision action; Work-specific names remain compatibility aliases. */
export type AgentPresetProvisionActionV1 = WorkPresetProvisionActionV1

/** Generic input accepted for RP Host and Work Agent preset assets. */
export type PreviewAgentPresetProvisionV1 = PreviewWorkPresetProvisionV1

/** Generic immutable provision plan shared by all versioned Agent presets. */
export type AgentPresetProvisionPlanV1 = WorkPresetProvisionPlanV1

/** Preview any versioned MistyMoon Agent preset without mutating DSH Home. */
export function previewAgentPresetProvision(
  input: PreviewAgentPresetProvisionV1,
): Promise<AgentPresetProvisionPlanV1> {
  return previewWorkPresetProvision(input)
}

/** Apply one unchanged Agent preset preview after explicit Owner confirmation. */
export function applyAgentPresetProvision(
  plan: AgentPresetProvisionPlanV1,
  options: { readonly ownerConfirmed: boolean },
): Promise<void> {
  return applyWorkPresetProvision(plan, options)
}

/** Compensate an unchanged preset created by a failed combined installation. */
export function compensateAgentPresetProvision(
  plan: AgentPresetProvisionPlanV1,
): Promise<void> {
  return compensateWorkPresetProvision(plan)
}
