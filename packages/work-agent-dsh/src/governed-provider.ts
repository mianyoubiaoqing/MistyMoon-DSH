import type { Context } from '@deepseek-ai/cordis'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { SubagentProvider } from '@deepseek-ai/dsh-subagent'
import { createFixedWorkPresetProvider } from './fixed-preset-provider.js'

const FINGERPRINT = /^[0-9a-f]{64}$/

/** Structural seam implemented by the pure work-agent publication module. */
export interface WorkActivationPublicationSelectionV1 {
  readonly version: 1
  readonly governanceFingerprint: string
  readonly baselineFingerprint: string
  readonly presetId: string
  readonly nativePresetId: string
  readonly presetFingerprint: string
  readonly route: {
    readonly id: string
    readonly provider: string
    readonly model: string
    readonly reasoning: string
  }
  readonly effectiveTools: readonly string[]
}

/** Trusted policy seam re-evaluated both before construction and at publication. */
export interface GovernedWorkPresetProviderOptions {
  readonly name: string
  readonly resolvePublication: () => WorkActivationPublicationSelectionV1
  /** Optional logical activation identity recorded in the child Session. */
  readonly activation?: {
    readonly logicalAgentId: string
    readonly profileRevision: number
    readonly profileId: string
  }
}

/** Signals that the governed selection changed during the unpublished transaction. */
export class StaleWorkActivationPublicationError extends Error {
  constructor() {
    super('work-agent-dsh: governed Work activation changed before publication')
    this.name = 'StaleWorkActivationPublicationError'
  }
}

function snapshot(
  publication: WorkActivationPublicationSelectionV1,
): WorkActivationPublicationSelectionV1 {
  if (publication.version !== 1) {
    throw new TypeError('work-agent-dsh: publication version must be 1')
  }
  for (const [name, value] of [
    ['governanceFingerprint', publication.governanceFingerprint],
    ['baselineFingerprint', publication.baselineFingerprint],
    ['presetFingerprint', publication.presetFingerprint],
  ] as const) {
    if (!FINGERPRINT.test(value)) {
      throw new TypeError(`work-agent-dsh: ${name} must be a lowercase SHA-256 digest`)
    }
  }
  return Object.freeze({
    ...publication,
    route: Object.freeze({ ...publication.route }),
    effectiveTools: Object.freeze([...publication.effectiveTools]),
  })
}

function samePublication(
  expected: WorkActivationPublicationSelectionV1,
  current: WorkActivationPublicationSelectionV1,
): boolean {
  return expected.governanceFingerprint === current.governanceFingerprint
    && expected.baselineFingerprint === current.baselineFingerprint
    && expected.presetId === current.presetId
    && expected.nativePresetId === current.nativePresetId
    && expected.presetFingerprint === current.presetFingerprint
    && expected.route.id === current.route.id
    && expected.route.provider === current.route.provider
    && expected.route.model === current.route.model
    && expected.route.reasoning === current.route.reasoning
    && expected.effectiveTools.length === current.effectiveTools.length
    && expected.effectiveTools.every((tool, index) => tool === current.effectiveTools[index])
}

/**
 * Create an inert one-shot provider from a pure governed publication snapshot.
 *
 * The Adapter never discovers manifests or provisions presets. The supplied
 * resolver owns those pure operations and is called synchronously again at the
 * DSH publication commit point so stale selections roll back with the child.
 */
export function createGovernedWorkPresetProvider(
  ctx: Context,
  options: GovernedWorkPresetProviderOptions,
): SubagentProvider {
  const expected = snapshot(options.resolvePublication())
  return createFixedWorkPresetProvider(ctx, {
    name: options.name,
    selection: {
      version: 1,
      nativePresetId: expected.nativePresetId,
      baselineFingerprint: expected.baselineFingerprint,
      presetFingerprint: expected.presetFingerprint,
      ...(options.activation === undefined ? {} : options.activation),
    },
    toolRestriction: { allow: expected.effectiveTools },
    modelSelection: {
      provider: expected.route.provider,
      model: expected.route.model,
      reasoningEffort: ReasoningEffortId(expected.route.reasoning),
    },
    validatePublication() {
      const current = snapshot(options.resolvePublication())
      if (!samePublication(expected, current)) {
        throw new StaleWorkActivationPublicationError()
      }
      return 'valid'
    },
  })
}
