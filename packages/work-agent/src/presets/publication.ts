import type {
  CompatibilityGateInputV1,
  CompatibilityReasonV1,
  WorkActivationPublicationV1,
} from '../contracts.js'
import { fingerprintCanonicalValue } from '../baseline/canonicalize.js'
import { CompatibilityGate } from './compatibility-gate.js'

/** A policy surface that cannot be published without re-selection or confirmation. */
export class WorkActivationPublicationError extends Error {
  constructor(
    readonly status: 'incompatible' | 'confirmation-required',
    readonly reasons: readonly CompatibilityReasonV1[],
  ) {
    super(`Work activation publication is ${status}.`)
    this.name = 'WorkActivationPublicationError'
  }
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value
  for (const child of Object.values(value)) deepFreeze(child)
  return Object.freeze(value)
}

/**
 * Collapse baseline, resolved preset, and compatibility output into one Adapter input.
 *
 * The result contains no provision path or prompt content. A caller must resolve it
 * again at the child publication point; a changed governance fingerprint is stale.
 */
export function prepareWorkActivationPublication(
  input: Pick<CompatibilityGateInputV1, 'baseline' | 'target'>,
): WorkActivationPublicationV1 {
  const decision = new CompatibilityGate().evaluate(input)
  if (decision.status !== 'compatible') {
    throw new WorkActivationPublicationError(decision.status, decision.reasons)
  }

  const surface = {
    version: 1 as const,
    baselineFingerprint: input.baseline.fingerprint,
    presetId: input.target.preset.id,
    nativePresetId: input.target.preset.nativePresetId,
    presetFingerprint: input.target.preset.manifestFingerprint,
    route: {
      ...input.target.route,
    },
    effectiveTools: [...decision.effectiveTools],
  }
  return deepFreeze({
    ...surface,
    governanceFingerprint: fingerprintCanonicalValue({
      surface,
      policy: input.target,
    }),
  })
}
