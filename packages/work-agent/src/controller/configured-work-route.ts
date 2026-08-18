import { fingerprintCanonicalValue } from '../baseline/canonicalize.js'
import type { WorkRouteIdV1, WorkRoutePolicyV1 } from '../contracts.js'

/** Bind an Owner-configured exact provider/model/reasoning tuple into one policy route id. */
export function configuredWorkRouteId(
  route: Pick<WorkRoutePolicyV1, 'provider' | 'model' | 'reasoning'>,
): WorkRouteIdV1 {
  return `configured-${fingerprintCanonicalValue({
    provider: route.provider,
    model: route.model,
    reasoning: route.reasoning,
  })}`
}
