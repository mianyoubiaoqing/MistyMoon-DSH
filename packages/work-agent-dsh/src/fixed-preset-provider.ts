import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import {
  foldConsumedWork,
  installModelSelection,
  type ModelSelection,
} from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  appendDelegatedPolicyOverrides,
  captureDelegatedPolicyOverrides,
  finalAssistantOutput,
  type ResolvedSubagentStartRequest,
  type SubagentProvider,
  type SubagentRun,
  type SubagentStopReason,
} from '@deepseek-ai/dsh-subagent'
import type { ToolRestriction } from '@deepseek-ai/dsh-tools'
import { createFreshWorkActivationWithSetup } from './fresh-activation.js'

/**
 * DSH delegation statement copied from `@deepseek-ai/dsh-subagent` rc.7.
 * See THIRD_PARTY_NOTICES.md for the fixed source commit and MIT attribution.
 */
const DELEGATION_CONTEXT = 'You are a delegated subagent: your permission scope was fixed when you were started and cannot be widened from inside this session — operations that require approval are rejected automatically. When the task needs access beyond that scope, do not retry the denied operation; state the limitation in your reply so the delegating agent can handle it.'

const FINGERPRINT = /^[0-9a-f]{64}$/
const PRESET_ID = /^[a-z0-9][a-z0-9-]*$/

/** Path-free, immutable selection recorded for every fixed-preset activation. */
export interface FixedWorkPresetSelectionV1 {
  readonly version: 1
  readonly nativePresetId: string
  readonly baselineFingerprint: string
  readonly presetFingerprint: string
  /** Stable logical Work Agent identity across fresh one-shot Sessions. */
  readonly logicalAgentId?: string
  /** Parent-governed profile revision frozen for this activation. */
  readonly profileRevision?: number
  /** Logical profile selected at that revision. */
  readonly profileId?: string
}

/** Durable audit event written before a fixed-preset child begins its turn. */
export interface WorkActivationSelectionEventV1 extends FixedWorkPresetSelectionV1 {
  readonly provider: string
}

/** Configuration shared by every one-shot run of one provider instance. */
export interface FixedWorkPresetProviderOptions {
  readonly name: string
  readonly selection: FixedWorkPresetSelectionV1
  readonly toolRestriction: ToolRestriction
  /** Optional exact request route owned by this provider rather than its callers. */
  readonly modelSelection?: ModelSelection
  readonly validatePublication: () => 'valid'
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Governed fixed preset and shared baseline selected for one fresh Work activation. */
    'mistymoon:work-activation': WorkActivationSelectionEventV1
  }
}

function validateOptions(options: FixedWorkPresetProviderOptions): void {
  if (options.name.trim() === '') throw new TypeError('work-agent-dsh: provider name must not be empty')
  if (options.selection.version !== 1) throw new TypeError('work-agent-dsh: selection version must be 1')
  if (!PRESET_ID.test(options.selection.nativePresetId)) {
    throw new TypeError('work-agent-dsh: nativePresetId must be a DSH preset id, not a path')
  }
  if (!FINGERPRINT.test(options.selection.baselineFingerprint)) {
    throw new TypeError('work-agent-dsh: baselineFingerprint must be a lowercase SHA-256 digest')
  }
  if (!FINGERPRINT.test(options.selection.presetFingerprint)) {
    throw new TypeError('work-agent-dsh: presetFingerprint must be a lowercase SHA-256 digest')
  }
  const { logicalAgentId, profileRevision, profileId } = options.selection
  const auditFields = [logicalAgentId, profileRevision, profileId]
  if (auditFields.some(value => value !== undefined) && auditFields.some(value => value === undefined)) {
    throw new TypeError('work-agent-dsh: logical activation audit fields must be supplied together')
  }
  if (logicalAgentId !== undefined && logicalAgentId.trim() === '') {
    throw new TypeError('work-agent-dsh: logicalAgentId must not be empty')
  }
  if (profileRevision !== undefined && (!Number.isSafeInteger(profileRevision) || profileRevision < 1)) {
    throw new TypeError('work-agent-dsh: profileRevision must be a positive safe integer')
  }
  if (profileId !== undefined && !PRESET_ID.test(profileId)) {
    throw new TypeError('work-agent-dsh: profileId must be a governed profile id')
  }
}

function selectionSnapshot(options: FixedWorkPresetProviderOptions): WorkActivationSelectionEventV1 {
  return Object.freeze({
    ...options.selection,
    provider: options.name,
  })
}

function restrictionSnapshot(restriction: ToolRestriction): ToolRestriction {
  return Object.freeze({
    ...(restriction.allow === undefined ? {} : { allow: Object.freeze([...restriction.allow]) }),
    ...(restriction.deny === undefined ? {} : { deny: Object.freeze([...restriction.deny]) }),
  })
}

function modelSelectionSnapshot(selection: ModelSelection | undefined): ModelSelection | undefined {
  if (selection === undefined) return undefined
  if (selection.provider.trim() === '' || selection.model.trim() === '') {
    throw new TypeError('work-agent-dsh: fixed model selection requires provider and model')
  }
  return Object.freeze({ ...selection })
}

function attachDescriptorAppend(childCtx: Context, descriptor: ResolvedSubagentStartRequest['descriptor']): void {
  let appended = false
  childCtx.on('agent/pre-step', async ({ agent }, next) => {
    const decision = await next()
    if (!appended && decision.kind === 'enter') {
      appended = true
      agent.session.append('subagent/descriptor', descriptor)
    }
    return decision
  })
}

function toStopReason(reason: { kind: string } | undefined): SubagentStopReason {
  switch (reason?.kind) {
    case 'completed': return 'completed'
    case 'max-tokens': return 'max-tokens'
    case 'aborted': return 'aborted'
    case 'blocked': return 'refusal'
    default: return 'error'
  }
}

function drivePublishedRun(
  handle: Awaited<ReturnType<typeof createFreshWorkActivationWithSetup>>,
  request: ResolvedSubagentStartRequest,
): SubagentRun {
  const child = handle.agent
  const flags = { cancelled: false }
  const onAbort = () => {
    flags.cancelled = true
    child.cancel({ kind: 'parent' })
  }
  request.signal.addEventListener('abort', onAbort, { once: true })
  if (request.signal.aborted) onAbort()

  const result = (async () => {
    try {
      if (!flags.cancelled) {
        child.followup(createUserMessage({
          content: request.prompt,
          source: { kind: 'user' },
        }))
        await child.whenIdle()
      }
      const consumed = foldConsumedWork(child.session.events)
      const recorded = toStopReason(consumed.end?.data.reason)
      return {
        output: finalAssistantOutput(child.session.events) ?? [],
        stopReason: flags.cancelled && recorded !== 'completed' ? 'aborted' : recorded,
      }
    } finally {
      request.signal.removeEventListener('abort', onAbort)
    }
  })()

  return {
    id: child.id,
    localAgent: child,
    result,
    async dispose() {
      request.signal.removeEventListener('abort', onAbort)
      flags.cancelled = true
      const disposal = (await Promise.allSettled([handle.dispose(), result]))[0]
      if (disposal.status === 'rejected') throw disposal.reason
    },
  }
}

function assertSupportedRequest(
  request: ResolvedSubagentStartRequest,
  modelSelection: ModelSelection | undefined,
): void {
  if (request.outputSchema !== undefined
    || request.maxDepth !== undefined
    || request.toolFilter !== undefined
    || request.persona !== undefined) {
    throw new TypeError('work-agent-dsh: fixed Work preset providers do not accept per-request composition overrides')
  }
  if (modelSelection !== undefined && request.agentOptions !== undefined) {
    const { provider, model, maxTokens } = request.agentOptions
    if ((provider !== undefined && provider !== modelSelection.provider)
      || (model !== undefined && model !== modelSelection.model)
      || maxTokens !== undefined) {
      throw new TypeError('work-agent-dsh: governed Work providers do not accept model-route overrides')
    }
  }
}

/**
 * Create a provider fixed to one governed preset and shared baseline snapshot.
 *
 * The provider is inert until a caller registers it with `ctx.subagents`; this
 * module never mutates the DSH bundle or Profile. Distinct providers implement
 * spawn-time preset selection while every run remains a fresh one-shot Session.
 */
export function createFixedWorkPresetProvider(
  ctx: Context,
  options: FixedWorkPresetProviderOptions,
): SubagentProvider {
  validateOptions(options)
  const selection = selectionSnapshot(options)
  const toolRestriction = restrictionSnapshot(options.toolRestriction)
  const modelSelection = modelSelectionSnapshot(options.modelSelection)

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
      assertSupportedRequest(request, modelSelection)
      if (request.signal.aborted) {
        throw new Error('work-agent-dsh: request was aborted before child publication')
      }
      const inheritedPolicy = captureDelegatedPolicyOverrides(request.parent)
      const childSessionId = SessionId(randomUUID())
      const handle = await createFreshWorkActivationWithSetup(ctx, {
        parent: request.parent,
        childSessionId,
        nativePresetId: selection.nativePresetId,
        agentOptions: modelSelection === undefined
          ? request.agentOptions
          : { provider: modelSelection.provider, model: modelSelection.model },
        signal: request.signal,
        validatePublication: options.validatePublication,
      }, (childCtx) => {
        const child = childCtx.agent
        if (child === undefined) throw new Error('work-agent-dsh: unpublished child context has no Agent')
        appendDelegatedPolicyOverrides(child.session, inheritedPolicy)
        child.session.append('mistymoon:work-activation', selection)
        childCtx.systemPrompt.context({
          name: 'subagent:delegation',
          order: 120,
          text: DELEGATION_CONTEXT,
        })
        childCtx.tools.restrict(toolRestriction)
        if (modelSelection !== undefined) {
          installModelSelection(childCtx, {
            current: modelSelection,
            assembled: undefined,
          })
        }
        attachDescriptorAppend(childCtx, request.descriptor)
      })
      return drivePublishedRun(handle, request)
    },
  })
}
