import type { WorkPresetIdV1 } from '../contracts.js'

/** Structural subset of a durable parent Session event used by the pure fold. */
export interface WorkProfileEventLike {
  readonly type: string
  readonly data: unknown
}

/** Profile frozen for one future fresh Work activation. */
export interface WorkProfileSelectionV1 {
  readonly version: 1
  readonly revision: number
  readonly profile: WorkPresetIdV1
}

/** Durable commit appended by the parent after a successful switch decision. */
export interface WorkProfileSwitchCommitV1 extends WorkProfileSelectionV1 {
  readonly requestId: string
  readonly previousRevision: number
  readonly reason: string
}

/** Owner-authored request to change only the next fresh activation. */
export interface SwitchWorkProfileRequestV1 {
  readonly version: 1
  readonly requestId: string
  readonly expectedRevision: number
  readonly targetProfile: WorkPresetIdV1
  readonly reason: string
  readonly ownerConfirmed: boolean
}

/** Stable switch outcome; callers append `commit` only for `committed`. */
export interface WorkProfileSwitchResultV1 {
  readonly status:
    | 'committed'
    | 'already-committed'
    | 'confirmation-required'
    | 'revision-conflict'
    | 'not-ready'
    | 'unchanged'
  readonly previous: WorkProfileSelectionV1
  readonly selection: WorkProfileSelectionV1
  readonly commit?: WorkProfileSwitchCommitV1
}

/** Trusted fixed profile availability for one product generation. */
export interface WorkProfileControllerOptions {
  readonly defaultProfile: WorkPresetIdV1
  readonly availableProfiles: readonly WorkPresetIdV1[]
}

const EVENT_TYPE = 'mistymoon:work-profile-switched'

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1
}

function profile(value: unknown): value is WorkPresetIdV1 {
  return value === 'anchored-standard' || value === 'anchored-standard-jspace'
}

function parseCommit(value: unknown): WorkProfileSwitchCommitV1 | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const input = value as Record<string, unknown>
  if (input.version !== 1
    || typeof input.requestId !== 'string'
    || input.requestId.trim() === ''
    || !positiveInteger(input.previousRevision)
    || !positiveInteger(input.revision)
    || input.revision !== input.previousRevision + 1
    || !profile(input.profile)
    || typeof input.reason !== 'string'
    || input.reason.trim() === '') return undefined
  return {
    version: 1,
    requestId: input.requestId,
    previousRevision: input.previousRevision,
    revision: input.revision,
    profile: input.profile,
    reason: input.reason,
  }
}

/**
 * Fold and commit logical Work profile revisions without touching DSH runtime.
 *
 * The module never mutates a running child. A caller appends the returned
 * commit to the parent Session, and each provider resolves/freeze the latest
 * committed selection immediately before creating a fresh one-shot child.
 */
export class WorkProfileController {
  private readonly available: ReadonlySet<WorkPresetIdV1>

  constructor(private readonly options: WorkProfileControllerOptions) {
    if (!profile(options.defaultProfile)) throw new TypeError('work profile default is invalid')
    if (!options.availableProfiles.includes(options.defaultProfile)) {
      throw new TypeError('work profile default must be available')
    }
    this.available = new Set(options.availableProfiles)
  }

  /** Fold the latest contiguous, versioned commit for the next activation. */
  resolveNextActivation(events: readonly WorkProfileEventLike[]): WorkProfileSelectionV1 {
    let selection: WorkProfileSelectionV1 = {
      version: 1,
      revision: 1,
      profile: this.options.defaultProfile,
    }
    for (const event of events) {
      if (event.type !== EVENT_TYPE) continue
      const commit = parseCommit(event.data)
      if (commit === undefined || commit.previousRevision !== selection.revision) continue
      selection = { version: 1, revision: commit.revision, profile: commit.profile }
    }
    return Object.freeze(selection)
  }

  /** Validate and return one append-only commit; the caller owns persistence. */
  switchProfile(
    events: readonly WorkProfileEventLike[],
    request: SwitchWorkProfileRequestV1,
  ): WorkProfileSwitchResultV1 {
    const previous = this.resolveNextActivation(events)
    for (const event of events) {
      if (event.type !== EVENT_TYPE) continue
      const existing = parseCommit(event.data)
      if (existing?.requestId === request.requestId) {
        return { status: 'already-committed', previous, selection: previous }
      }
    }
    if (request.version !== 1
      || request.requestId.trim() === ''
      || request.reason.trim() === ''
      || !positiveInteger(request.expectedRevision)
      || !profile(request.targetProfile)) {
      throw new TypeError('work profile switch request is invalid')
    }
    if (request.expectedRevision !== previous.revision) {
      return { status: 'revision-conflict', previous, selection: previous }
    }
    if (!this.available.has(request.targetProfile)) {
      return { status: 'not-ready', previous, selection: previous }
    }
    if (request.targetProfile === previous.profile) {
      return { status: 'unchanged', previous, selection: previous }
    }
    if (request.targetProfile === 'anchored-standard-jspace' && !request.ownerConfirmed) {
      return { status: 'confirmation-required', previous, selection: previous }
    }
    const commit = Object.freeze({
      version: 1 as const,
      requestId: request.requestId,
      previousRevision: previous.revision,
      revision: previous.revision + 1,
      profile: request.targetProfile,
      reason: request.reason,
    })
    return {
      status: 'committed',
      previous,
      selection: Object.freeze({ version: 1, revision: commit.revision, profile: commit.profile }),
      commit,
    }
  }
}
