import type {
  ResolvedSubagentStartRequest,
  SubagentProvider,
  SubagentRun,
} from '@deepseek-ai/dsh-subagent'
import { resolveSessionPreset } from '@deepseek-ai/dsh-agent-presets'

/** A parent already owns one foreground Work activation. */
export class WorkActivationBusyError extends Error {
  constructor() {
    super('work-agent-dsh: the RP Host already has an active foreground Work activation')
    this.name = 'WorkActivationBusyError'
  }
}

/** A child or non-RP preset attempted to enter the RP Host provider seam. */
export class WorkActivationRoleError extends Error {
  constructor() {
    super('work-agent-dsh: only a top-level RP Host preset may start a Work activation')
    this.name = 'WorkActivationRoleError'
  }
}

/** Configuration for the code-enforced star-topology provider. */
export interface ExclusiveWorkPresetProviderOptions {
  readonly name: string
  readonly expectedParentPreset: string
  /** Shared by Flash/Pro adapters so both serialize the same RP Host. */
  readonly gate?: WorkActivationGate
  /** Stable workspace or logical-agent lease key; defaults to the parent id. */
  readonly leaseKey?: (request: ResolvedSubagentStartRequest) => string
  /** Resolve and freeze the current profile-specific provider at start time. */
  readonly resolveProvider: (request: ResolvedSubagentStartRequest) => SubagentProvider
}

/** Shared per-parent lease registry for all fixed Work provider adapters. */
export class WorkActivationGate {
  private readonly active = new Map<string, symbol>()

  /** Whether this exact RP Host still owns an undisposed Work activation. */
  isActive(parentId: string): boolean {
    return this.active.has(parentId)
  }

  /** Acquire one lease and return its idempotent release capability. */
  acquire(parentId: string): () => void {
    if (this.active.has(parentId)) throw new WorkActivationBusyError()
    const token = Symbol(parentId)
    this.active.set(parentId, token)
    return () => {
      if (this.active.get(parentId) === token) this.active.delete(parentId)
    }
  }
}

/**
 * Serialize foreground Work activations per RP Host and reject recursive use.
 *
 * The lock is held until the caller disposes the returned run, even if its
 * result has already settled. This makes child/session release—not model text—
 * the authority for shared-workspace write serialization.
 */
export function createExclusiveWorkPresetProvider(
  options: ExclusiveWorkPresetProviderOptions,
): SubagentProvider {
  if (options.name.trim() === '' || options.expectedParentPreset.trim() === '') {
    throw new TypeError('work-agent-dsh: exclusive provider name and parent preset are required')
  }
  const gate = options.gate ?? new WorkActivationGate()
  return Object.freeze({
    name: options.name,
    inheritsParentContext: false,
    capabilities: Object.freeze({
      outputSchema: false,
      depthLimit: false,
      toolFilter: false,
      persona: false,
    }),
    async start(request: ResolvedSubagentStartRequest): Promise<SubagentRun> {
      if ((request.parent.session.header.delegationDepth ?? 0) !== 0
        || resolveSessionPreset(request.parent.session) !== options.expectedParentPreset) {
        throw new WorkActivationRoleError()
      }
      const leaseKey = options.leaseKey?.(request) ?? String(request.parent.id)
      if (leaseKey.trim() === '') {
        throw new TypeError('work-agent-dsh: Work activation lease key must not be empty')
      }
      const release = gate.acquire(leaseKey)
      let run: SubagentRun
      try {
        run = await options.resolveProvider(request).start(request)
      } catch (error) {
        release()
        throw error
      }
      let disposal: Promise<void> | undefined
      return {
        ...run,
        dispose() {
          disposal ??= (async () => {
            try {
              await run.dispose()
            } finally {
              release()
            }
          })()
          return disposal
        },
      }
    },
  })
}
