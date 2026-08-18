import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle, AgentOptions } from '@deepseek-ai/dsh-agent'
import type { AgentPresets } from '@deepseek-ai/dsh-agent-presets'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { resolveChildAgentOptions, resolveChildDepth } from '@deepseek-ai/dsh-subagent'

/** Inputs for one unpublished, fresh Work Agent creation transaction. */
export interface CreateFreshWorkActivationRequest {
  /** Exact live RP Host Agent that owns the child lifecycle. */
  readonly parent: Agent
  /** Caller-reserved identity for the new Agent and its empty Session. */
  readonly childSessionId: SessionId
  /** Complete, previously governed DSH preset id; never a filesystem path. */
  readonly nativePresetId: string
  /** Optional model-route overrides, resolved against the parent's Agent options. */
  readonly agentOptions?: AgentOptions
  /** Creation-only cancellation; the future one-shot driver owns post-publication handoff. */
  readonly signal: AbortSignal
  /** Synchronous baseline/manifest revalidation at DSH's publication commit point. */
  readonly validatePublication: () => 'valid'
}

/**
 * Publish one empty depth-one Work Agent under an explicit complete preset.
 *
 * The child does not inherit the parent's preset or transcript. Preset mounting
 * happens inside DSH's unpublished setup transaction, so any failure rejects
 * without leaving a live Agent or Session. The returned handle is the caller's
 * sole lifecycle capability and must be disposed after the one-shot run. The
 * supplied context must explicitly inject `agentPresets`; creation itself still
 * runs through `parent.ctx.agents` so DSH records the runtime ownership edge.
 */
export async function createFreshWorkActivation(
  ctx: Context,
  request: CreateFreshWorkActivationRequest,
): Promise<AgentHandle> {
  return createFreshWorkActivationWithSetup(ctx, request)
}

/** Internal extension used by the one-shot driver to compose child-local policy. */
export async function createFreshWorkActivationWithSetup(
  ctx: Context,
  request: CreateFreshWorkActivationRequest,
  compose?: (childCtx: Context) => void,
): Promise<AgentHandle> {
  const {
    parent,
    childSessionId,
    nativePresetId,
    agentOptions,
    signal,
    validatePublication,
  } = request
  const delegationDepth = resolveChildDepth(parent, 1)
  const cwd = parent.session.header.cwd
  const presets: AgentPresets = ctx.agentPresets

  return parent.ctx.agents.create({
    sessionId: childSessionId,
    meta: {
      ...(cwd === undefined ? {} : { cwd }),
      parentSession: parent.id,
      seedLength: 0,
      origin: 'subagent',
      delegationDepth,
      agentPreset: nativePresetId,
    },
    agentOptions: resolveChildAgentOptions(parent, agentOptions, delegationDepth),
    signal,
    async setup(childCtx) {
      const mounted = await presets.mount(childCtx, nativePresetId)
      if (mounted.id !== nativePresetId) {
        throw new Error(`work-agent-dsh: mounted preset ${JSON.stringify(mounted.id)} does not match requested preset ${JSON.stringify(nativePresetId)}`)
      }
      compose?.(childCtx)
      return {
        commit() {
          if (validatePublication() !== 'valid') {
            throw new Error('work-agent-dsh: publication validation did not return valid')
          }
        },
      }
    },
  })
}
