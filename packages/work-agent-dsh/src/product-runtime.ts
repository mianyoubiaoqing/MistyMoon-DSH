import type { Context } from '@deepseek-ai/cordis'
import { resolve } from 'node:path'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CommandDefinition } from '@deepseek-ai/dsh-commands'
import { ReasoningEffortId, type LlmModelInfo } from '@deepseek-ai/dsh-llm'
import type { SubagentProvider } from '@deepseek-ai/dsh-subagent'
import {
  configuredWorkRouteId,
  getFixedWorkPresetManifests,
  prepareWorkActivationPublication,
  SharedBaselineRegistry,
  WorkPresetResolver,
  WorkProfileController,
  type SharedBaselineDefinitionV1,
  type SwitchWorkProfileRequestV1,
  type WorkActivationPolicyV1,
  type WorkActivationPublicationV1,
  type WorkProfileEventLike,
  type WorkProfileSelectionV1,
  type WorkProfileSwitchCommitV1,
  type WorkProfileSwitchResultV1,
  type WorkRoutePolicyV1,
} from '@mistymoon/dsh/work-agent'
import {
  createExclusiveWorkPresetProvider,
  WorkActivationGate,
  WorkActivationRoleError,
} from './exclusive-provider.js'
import { createGovernedWorkPresetProvider } from './governed-provider.js'
import {
  DEFAULT_WORK_MODEL_ROUTE,
  loadWorkModelRouteSettings,
  saveWorkModelRouteSettings,
  type ConfigureWorkModelRouteRequestV1,
  type WorkModelCatalogEntryV1,
  type WorkModelRouteSettingsV1,
} from './model-route-settings.js'
import { createWorkReportProvider } from './work-report.js'

/** Cordis plugin name for the product Work provider plane. */
export const name = 'mistymoon-work-agent-runtime'

/** Host-plane registries required before product providers can be published. */
export const inject = ['subagents', 'agentPresets', 'llm']

export const RP_HOST_PRESET_ID = 'mistymoon-rp-host-v1'
export const WORK_LOGICAL_AGENT_ID = 'mistymoon-work-v1'
export const FLASH_PROVIDER_NAME = 'mistymoon-work-flash'

const DSH_COMPATIBILITY = {
  version: '0.1.0-rc.7',
  commit: '99f6f02fecdb7dff40c3fbc9470f5907c29f74ca',
} as const

const WORK_TOOLS = Object.freeze([
  'bash',
  'str_replace_editor',
  'dev_tool_search',
  'skill_search',
  'skill_load',
  'read',
  'write',
  'edit',
  'glob',
  'grep',
  'todo_write',
])

const PROTECTED_SECTIONS = Object.freeze([
  'harness:identity',
  'deployment:persona',
  'agent-instructions',
  'sandbox:policy',
  'permissions',
  'plan',
  'skills',
])

const DIRECT_FLASH_ROUTE = Object.freeze({
  id: 'flash-max',
  provider: 'deepseek-official',
  model: 'deepseek-v4-flash',
  reasoning: 'max',
} satisfies WorkRoutePolicyV1)

function baselineDefinition(routes: readonly WorkRoutePolicyV1[]): SharedBaselineDefinitionV1 {
  return {
    version: 1,
    generation: 'mistymoon-work-rc7-v1',
    dshCompatibility: DSH_COMPATIBILITY,
    ownerEligibilityPolicy: 'mistymoon-owner-eligibility-v1',
    protectedSections: PROTECTED_SECTIONS,
    workspacePolicy: 'parent-cwd-only',
    sandboxCeiling: 'workspace-write',
    approvalPolicy: 'never',
    maxDelegationDepth: 1,
    providerAllowlist: [...new Set(routes.map(route => route.provider))],
    modelAllowlist: [...new Set(routes.map(route => route.model))],
    rolePolicies: {
      rpHost: {
        toolAllow: ['web_search', 'web_fetch', FLASH_PROVIDER_NAME],
        toolDeny: ['bash', 'str_replace_editor', 'write', 'edit'],
      },
      workAgent: {
        toolAllow: WORK_TOOLS,
        toolDeny: [
          'mistymoon_prepare_final_reply',
          'memory_list',
          'memory_replace',
          'memory_forget',
          'memory_candidate_propose',
          'memory_candidate_list',
          'memory_candidate_approve',
          'memory_candidate_reject',
          'subagent',
          'subagent_fork',
          'send_message',
          'list_agents',
          'interrupt_agent',
          'workflow',
          'ralph',
        ],
      },
    },
    contractVersions: { delegation: 1, report: 1, handoff: 1 },
  }
}

/** Product runtime configuration; J-Space remains disabled unless explicitly qualified. */
export interface Config {
  readonly enableJSpace?: boolean
  /** Private versioned selection containing provider/model references but no credentials. */
  readonly settingsPath?: string
}

/** Runtime schema for the product Work provider plane. */
export const Config: z<Config> = z.object({
  enableJSpace: z.boolean().default(false),
  settingsPath: z.string(),
})

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Owner-governed Work profile commit stored on the RP Host Session. */
    'mistymoon:work-profile-switched': WorkProfileSwitchCommitV1
  }
}

function eventView(agent: Agent): readonly WorkProfileEventLike[] {
  return agent.session.events
}

function assertRpHost(agent: Agent): void {
  if ((agent.session.header.delegationDepth ?? 0) !== 0
    || agent.session.header.agentPreset !== RP_HOST_PRESET_ID) {
    throw new WorkActivationRoleError()
  }
}

function workspaceLeaseKey(agent: Agent): string {
  const cwd = agent.session.header.cwd?.trim()
  if (cwd === undefined || cwd === '') return `logical-agent:${WORK_LOGICAL_AGENT_ID}`
  const normalized = resolve(cwd)
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

/**
 * Own the qualified star-topology Flash Work provider and next-activation profile fold.
 *
 * It has no Persona, Memory, transcript-copy, path-discovery, or provision
 * capability. Each provider resolves the parent Session commit immediately
 * before creating one fresh child and rechecks it at DSH publication.
 */
export class RpWorkDelegationRuntime {
  readonly #ctx: Context
  readonly #gate = new WorkActivationGate()
  readonly #resolver: WorkPresetResolver
  readonly #profiles: WorkProfileController
  readonly #providers: readonly SubagentProvider[]
  readonly #settingsPath: string | undefined
  #modelSettings: WorkModelRouteSettingsV1
  #settingsUpdate: Promise<void> = Promise.resolve()

  constructor(
    ctx: Context,
    config: Config = {},
    initialModelSettings: WorkModelRouteSettingsV1 = DEFAULT_WORK_MODEL_ROUTE,
  ) {
    this.#ctx = ctx
    this.#settingsPath = config.settingsPath
    this.#modelSettings = initialModelSettings
    const manifests = getFixedWorkPresetManifests()
    const enableJSpace = config.enableJSpace ?? false
    this.#resolver = new WorkPresetResolver({
      dshCompatibility: DSH_COMPATIBILITY,
      manifests,
      discovery: manifests
        .filter(({ preset }) => preset.id === 'anchored-standard' || enableJSpace)
        .map(({ preset }) => ({
          nativePresetId: preset.nativePresetId,
          manifestFingerprint: preset.manifestFingerprint,
          upstreams: preset.upstreams,
          immutableProvision: true,
          capabilities: preset.id === 'anchored-standard-jspace'
            ? ['j-space-experiment-enabled']
            : [],
        })),
    })
    this.#profiles = new WorkProfileController({
      defaultProfile: 'anchored-standard',
      availableProfiles: enableJSpace
        ? ['anchored-standard', 'anchored-standard-jspace']
        : ['anchored-standard'],
    })
    this.#providers = Object.freeze([this.#provider(FLASH_PROVIDER_NAME)])
  }

  /** Fixed qualified provider consumed by the RP Host preset tool. */
  providers(): readonly SubagentProvider[] {
    return this.#providers
  }

  /** Fold the parent commit that will be frozen for the next fresh child. */
  selection(agent: Agent): WorkProfileSelectionV1 {
    assertRpHost(agent)
    return this.#profiles.resolveNextActivation(eventView(agent))
  }

  /** Current credential-free default used only by future fresh activations. */
  modelSettings(): WorkModelRouteSettingsV1 {
    return this.#modelSettings
  }

  /** List Work-compatible models from the live DSH registry without exposing credentials. */
  async modelCatalog(): Promise<readonly WorkModelCatalogEntryV1[]> {
    const entries: WorkModelCatalogEntryV1[] = []
    for (const provider of this.#ctx.llm.listProviders()) {
      let models: LlmModelInfo[]
      try {
        models = await this.#ctx.llm.listModels(provider.id)
      } catch {
        continue
      }
      for (const model of models) {
        try {
          await this.#ctx.llm.resolveCallConfig({
            provider: provider.id,
            model: model.id,
            reasoningEffort: ReasoningEffortId('max'),
          })
        } catch {
          continue
        }
        const direct = provider.id === DEFAULT_WORK_MODEL_ROUTE.provider
          && model.id === DEFAULT_WORK_MODEL_ROUTE.model
        entries.push(Object.freeze({
          provider: provider.id,
          providerName: provider.name,
          model: model.id,
          modelName: model.name,
          ...(model.description === undefined ? {} : { description: model.description }),
          qualification: direct ? 'qualified-direct' : 'experimental-owner-configured',
        }))
      }
    }
    return Object.freeze(entries.toSorted((left, right) =>
      left.provider.localeCompare(right.provider) || left.model.localeCompare(right.model)))
  }

  /** Validate and persist the deployment default for future fresh activations. */
  configureModelRoute(
    request: ConfigureWorkModelRouteRequestV1,
  ): Promise<WorkModelRouteSettingsV1> {
    const update = this.#settingsUpdate.then(async () => {
      if (request.version !== 1
        || !Number.isSafeInteger(request.expectedRevision)
        || request.expectedRevision < 1
        || request.provider.trim() === ''
        || request.model.trim() === '') {
        throw new TypeError('mistymoon-work-agent: Work model route request is invalid')
      }
      if (request.expectedRevision !== this.#modelSettings.revision) {
        throw new Error('mistymoon-work-agent: Work model route revision changed; reload settings')
      }
      const provider = request.provider.trim()
      const model = request.model.trim()
      const direct = provider === DEFAULT_WORK_MODEL_ROUTE.provider
        && model === DEFAULT_WORK_MODEL_ROUTE.model
      if (!direct && !request.ownerConfirmed) {
        throw new Error('mistymoon-work-agent: experimental Work model routes require Owner confirmation')
      }
      const catalog = await this.modelCatalog()
      if (!catalog.some(entry => entry.provider === provider && entry.model === model)) {
        throw new Error('mistymoon-work-agent: selected provider/model is not in the live DSH model catalog')
      }
      if (provider === this.#modelSettings.provider && model === this.#modelSettings.model) {
        return this.#modelSettings
      }
      const next = Object.freeze({
        version: 1 as const,
        revision: this.#modelSettings.revision + 1,
        provider,
        model,
        reasoning: 'max' as const,
        qualification: direct
          ? 'qualified-direct' as const
          : 'experimental-owner-configured' as const,
      })
      if (this.#settingsPath !== undefined) {
        await saveWorkModelRouteSettings(this.#settingsPath, next)
      }
      this.#modelSettings = next
      return next
    })
    this.#settingsUpdate = update.then(() => undefined, () => undefined)
    return update
  }

  /** Whether an undisposed foreground child still owns the parent's workspace lease. */
  isBusy(agent: Agent): boolean {
    assertRpHost(agent)
    return this.#gate.isActive(workspaceLeaseKey(agent))
  }

  /**
   * Append one validated switch commit to the parent Session.
   * The commit never mutates an existing child and is rejected while busy.
   */
  switchProfile(
    agent: Agent,
    request: SwitchWorkProfileRequestV1,
  ): WorkProfileSwitchResultV1 {
    assertRpHost(agent)
    if (this.#gate.isActive(workspaceLeaseKey(agent))) {
      throw new Error('mistymoon-work-agent: profile switch rejected while an activation is busy')
    }
    const result = this.#profiles.switchProfile(eventView(agent), request)
    if (result.status === 'committed') {
      agent.session.append('mistymoon:work-profile-switched', result.commit!)
    }
    return result
  }

  /** Resolve the path-free publication snapshot for diagnostics and tests. */
  publication(agent: Agent): WorkActivationPublicationV1 {
    assertRpHost(agent)
    const selection = this.#profiles.resolveNextActivation(eventView(agent))
    const configured = this.#modelSettings
    const route: WorkRoutePolicyV1 = configured.qualification === 'qualified-direct'
      ? DIRECT_FLASH_ROUTE
      : Object.freeze({
          id: configuredWorkRouteId(configured),
          provider: configured.provider,
          model: configured.model,
          reasoning: configured.reasoning,
        })
    const baseline = new SharedBaselineRegistry().resolve(baselineDefinition(
      route.id === DIRECT_FLASH_ROUTE.id ? [DIRECT_FLASH_ROUTE] : [DIRECT_FLASH_ROUTE, route],
    ))
    const preset = this.#resolver.resolve(selection.profile)
    const target: WorkActivationPolicyV1 = {
      version: 1,
      baselineFingerprint: baseline.fingerprint,
      preset,
      route,
      toolCatalog: WORK_TOOLS,
      sandbox: 'workspace-write',
      approval: 'never',
      delegationDepth: 1,
      prompt: {
        persona: 'neutral-work',
        runtimeContext: 'preserve',
        sectionPolicy: 'preserve',
        protectedSections: PROTECTED_SECTIONS,
      },
    }
    return prepareWorkActivationPublication({ baseline, target })
  }

  #provider(name: string): SubagentProvider {
    return createExclusiveWorkPresetProvider({
      name,
      expectedParentPreset: RP_HOST_PRESET_ID,
      gate: this.#gate,
      leaseKey: request => workspaceLeaseKey(request.parent),
      resolveProvider: (request) => {
        const selection = this.#profiles.resolveNextActivation(eventView(request.parent))
        return createWorkReportProvider(createGovernedWorkPresetProvider(this.#ctx, {
          name,
          activation: {
            logicalAgentId: WORK_LOGICAL_AGENT_ID,
            profileRevision: selection.revision,
            profileId: selection.profile,
          },
          resolvePublication: () => this.publication(request.parent),
        }))
      },
    })
  }
}

function profileCommand(runtime: RpWorkDelegationRuntime): CommandDefinition {
  return {
    name: 'work-profile',
    description: 'Show or switch the complete Work preset used by the next fresh activation',
    input: { hint: '[anchored-standard|anchored-standard-jspace --confirm]' },
    recordInput: false,
    handler: ({ agent, rawInput, commandId }) => {
      let current: WorkProfileSelectionV1
      try {
        current = runtime.selection(agent)
      } catch {
        return { kind: 'error' as const, text: 'Work profiles are available only on the MistyMoon RP Host preset.' }
      }
      const parts = rawInput.trim().split(/\s+/).filter(Boolean)
      if (parts.length === 0) {
        return {
          kind: 'success' as const,
          text: `Next Work activation uses ${current.profile} at revision ${current.revision}.`,
        }
      }
      const target = parts[0]
      const confirmed = parts.length === 2 && parts[1] === '--confirm'
      if ((target !== 'anchored-standard' && target !== 'anchored-standard-jspace')
        || parts.length > (confirmed ? 2 : 1)) {
        return { kind: 'error' as const, text: 'Usage: /work-profile anchored-standard or /work-profile anchored-standard-jspace --confirm' }
      }
      try {
        const result = runtime.switchProfile(agent, {
          version: 1,
          requestId: String(commandId),
          expectedRevision: current.revision,
          targetProfile: target,
          reason: 'Owner selected the next Work activation profile.',
          ownerConfirmed: confirmed,
        })
        if (result.status === 'committed') {
          return { kind: 'success' as const, text: `Next Work activation uses ${result.selection.profile} at revision ${result.selection.revision}.` }
        }
        const messages: Record<WorkProfileSwitchResultV1['status'], string> = {
          committed: 'Work profile committed.',
          'already-committed': 'This Work profile switch was already committed.',
          'confirmation-required': 'J-Space requires --confirm because it increases the experimental capability surface.',
          'revision-conflict': 'The Work profile changed concurrently; retry the command.',
          'not-ready': 'That Work profile is not provisioned and enabled in this deployment.',
          unchanged: `Next Work activation already uses ${result.selection.profile}.`,
        }
        if (result.status === 'unchanged' || result.status === 'already-committed') {
          return { kind: 'success' as const, text: messages[result.status]! }
        }
        return { kind: 'error' as const, text: messages[result.status]! }
      } catch (error) {
        return { kind: 'error' as const, text: error instanceof Error ? error.message : 'Work profile switch failed.' }
      }
    },
  }
}

/** Register the qualified Flash provider and Owner command adapter. */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const settings = config.settingsPath === undefined
    ? DEFAULT_WORK_MODEL_ROUTE
    : await loadWorkModelRouteSettings(config.settingsPath)
  const runtime = new RpWorkDelegationRuntime(ctx, config, settings)
  ctx.effect(
    () => ctx.provide('mistymoonWorkDelegation', runtime),
    'mistymoon-work-agent: runtime service',
  )
  for (const provider of runtime.providers()) {
    ctx.effect(
      () => ctx.subagents.registerProvider(provider),
      `mistymoon-work-agent: provider ${provider.name}`,
    )
  }
  ctx.inject(['commands'], commandCtx => commandCtx.commands.register(profileCommand(runtime)))
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Product Work provider and next-activation profile controller. */
    mistymoonWorkDelegation: RpWorkDelegationRuntime
  }
}
