/** Tool limits applied after the shared baseline is mounted for a role. */
export interface WorkRolePolicyV1 {
  readonly toolAllow: readonly string[]
  readonly toolDeny: readonly string[]
}

/** Terminal task state reported by one fresh Work activation. */
export type WorkReportStatusV1 = 'completed' | 'blocked' | 'failed'

/** One exact verification command and its observed outcome. */
export interface WorkReportCheckV1 {
  readonly command: string
  readonly status: 'passed' | 'failed' | 'not-run'
  readonly summary: string
}

/** A bounded verbatim artifact whose technical content the RP Host must preserve. */
export interface WorkReportArtifactV1 {
  readonly kind: 'text' | 'code' | 'patch' | 'command-output' | 'citation'
  readonly label: string
  readonly content: string
}

/** Versioned, model-produced result validated before the RP Host can consume it. */
export interface WorkReportV1 {
  readonly version: 1
  readonly status: WorkReportStatusV1
  readonly summary: string
  readonly changedFiles: readonly string[]
  readonly checksRun: readonly WorkReportCheckV1[]
  readonly risks: readonly string[]
  readonly needsUserAction: readonly string[]
  readonly artifacts: readonly WorkReportArtifactV1[]
}

/** DSH build identity against which a governed artifact was verified. */
export interface DshCompatibilityV1 {
  readonly version: string
  readonly commit: string
}

/** Trusted, versioned input used to create an immutable shared baseline. */
export interface SharedBaselineDefinitionV1 {
  readonly version: 1
  readonly generation: string
  readonly dshCompatibility: DshCompatibilityV1
  readonly ownerEligibilityPolicy: string
  readonly protectedSections: readonly string[]
  readonly workspacePolicy: 'parent-cwd-only'
  readonly sandboxCeiling: 'read-only' | 'workspace-write'
  readonly approvalPolicy: 'never'
  readonly maxDelegationDepth: 1
  readonly providerAllowlist: readonly string[]
  readonly modelAllowlist: readonly string[]
  readonly rolePolicies: {
    readonly rpHost: WorkRolePolicyV1
    readonly workAgent: WorkRolePolicyV1
  }
  readonly contractVersions: {
    readonly delegation: 1
    readonly report: 1
    readonly handoff: 1
  }
}

/** Immutable governance projection shared by an RP Host and its Work Agents. */
export interface SharedBaselineSnapshotV1 extends SharedBaselineDefinitionV1 {
  readonly fingerprint: string
}

/** Fixed profile ids selectable by the Phase 0 Work Agent contracts. */
export type WorkPresetIdV1 = 'anchored-standard' | 'anchored-standard-jspace'

/** Pinned upstream identity recorded without local provision paths. */
export interface WorkPresetUpstreamV1 {
  readonly project: 'anchored-standard' | 'j-space'
  readonly commit: string
  readonly checksum: string
  readonly checksumAlgorithm: 'sha256-git-ls-tree-v1'
  readonly delivery: 'bundled' | 'external'
  readonly licenseStatus: 'ready' | 'external-only' | 'not-ready'
  readonly licenseSpdx: 'MIT' | 'Apache-2.0' | 'NOASSERTION'
  readonly protectedSectionsCompatibility: 'preserves' | 'requires-policy-shield'
}

/** Durable, path-free reference to one complete Work Agent preset. */
export interface WorkPresetRefV1 {
  readonly version: 1
  readonly id: WorkPresetIdV1
  readonly nativePresetId: string
  readonly manifestFingerprint: string
  readonly upstreams: readonly WorkPresetUpstreamV1[]
}

/** Trusted registry manifest; actual preset files remain behind the resolver. */
export interface WorkPresetManifestV1 {
  readonly version: 1
  readonly preset: WorkPresetRefV1
  readonly dshCompatibility: DshCompatibilityV1
  readonly compatibilityPatchVersion: string
  readonly licenseStatus: 'ready' | 'external-only' | 'not-ready'
  readonly activationStatus: 'default' | 'experimental-disabled'
  readonly requiredCapabilities: readonly string[]
}

/** Sanitized discovery evidence supplied by the future DSH adapter boundary. */
export interface WorkPresetDiscoveryV1 {
  readonly nativePresetId: string
  readonly manifestFingerprint: string
  readonly upstreams: readonly WorkPresetUpstreamV1[]
  readonly immutableProvision: boolean
  readonly capabilities: readonly string[]
}

/** Trusted manifests and sanitized discovery evidence for one DSH build. */
export interface WorkPresetResolverOptions {
  readonly dshCompatibility: DshCompatibilityV1
  readonly manifests: readonly WorkPresetManifestV1[]
  readonly discovery: readonly WorkPresetDiscoveryV1[]
}

/** Verified preset reference safe to pass to a child composer. */
export interface ResolvedWorkPresetV1 extends WorkPresetRefV1 {
  readonly compatibilityPatchVersion: string
}

/** Routes whose provider/model/reasoning tuples are fixed by policy. */
export type WorkRouteIdV1 = 'flash-max' | 'pro-max' | `configured-${string}`

/** Captured provider request policy for one Work activation. */
export interface WorkRoutePolicyV1 {
  readonly id: WorkRouteIdV1
  readonly provider: string
  readonly model: string
  readonly reasoning: 'max' | 'high' | 'medium' | 'low' | 'disabled'
}

/** Prompt preservation assertions checked before child publication. */
export interface WorkPromptPolicyV1 {
  readonly persona: 'neutral-work' | 'complete' | 'roleplay'
  readonly runtimeContext: 'preserve' | 'suppress'
  readonly sectionPolicy: 'preserve' | 'clear-other-sections'
  readonly protectedSections: readonly string[]
}

/** Model-visible and executable policy proposed for one fresh Work activation. */
export interface WorkActivationPolicyV1 {
  readonly version: 1
  readonly baselineFingerprint: string
  readonly preset: ResolvedWorkPresetV1
  readonly route: WorkRoutePolicyV1
  readonly toolCatalog: readonly string[]
  readonly sandbox: 'read-only' | 'workspace-write'
  readonly approval: 'never' | 'on-request'
  readonly delegationDepth: number
  readonly prompt: WorkPromptPolicyV1
}

/** Inputs for comparing a proposed activation and optional previous surface. */
export interface CompatibilityGateInputV1 {
  readonly baseline: SharedBaselineSnapshotV1
  readonly target: WorkActivationPolicyV1
  readonly current?: WorkActivationPolicyV1
}

/** Stable machine-readable causes for rejecting an activation surface. */
export type CompatibilityReasonCodeV1 =
  | 'baseline-mismatch'
  | 'tool-outside-ceiling'
  | 'tool-denied'
  | 'sandbox-escalation'
  | 'approval-escalation'
  | 'delegation-depth-exceeded'
  | 'persona-override'
  | 'runtime-context-suppressed'
  | 'protected-sections-cleared'
  | 'protected-section-missing'
  | 'provider-not-allowed'
  | 'model-not-allowed'
  | 'route-mismatch'
  | 'reasoning-not-max'

/** One policy violation with a non-sensitive subject identifier. */
export interface CompatibilityReasonV1 {
  readonly code: CompatibilityReasonCodeV1
  readonly subject: string
}

/** Governed surface that changed between two fresh activations. */
export type PolicyDifferenceKindV1 =
  | 'profile-changed'
  | 'route-changed'
  | 'tool-added'
  | 'tool-removed'

/** Whether a switch raises or lowers capability or expected route cost. */
export type PolicyDifferenceImpactV1 =
  | 'capability-increase'
  | 'capability-decrease'
  | 'cost-increase'
  | 'cost-decrease'

/** Structured switch difference used by the future Owner confirmation flow. */
export interface PolicyDifferenceV1 {
  readonly kind: PolicyDifferenceKindV1
  readonly subject: string
  readonly impact: PolicyDifferenceImpactV1
}

/** Frozen result consumed by the future child creation transaction. */
export interface CompatibilityDecisionV1 {
  readonly status: 'compatible' | 'incompatible' | 'confirmation-required'
  readonly effectiveTools: readonly string[]
  readonly differences: readonly PolicyDifferenceV1[]
  readonly reasons: readonly CompatibilityReasonV1[]
}

/** Immutable, path-free policy result consumed by a DSH lifecycle Adapter. */
export interface WorkActivationPublicationV1 {
  readonly version: 1
  readonly governanceFingerprint: string
  readonly baselineFingerprint: string
  readonly presetId: WorkPresetIdV1
  readonly nativePresetId: string
  readonly presetFingerprint: string
  readonly route: WorkRoutePolicyV1
  readonly effectiveTools: readonly string[]
}
