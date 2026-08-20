# DSH Work Agent Adapter

`@mistymoon/dsh-work-agent-dsh` is the only module in MistyMoon Phase 0 that
touches the DSH Agent and preset lifecycles. It is separate from the pure
`@mistymoon/dsh-work-agent` contracts and has no dependency on Foundation,
Memory, Settings UI, Persona, or private user data.

The current public interface is `createFreshWorkActivation(ctx, request)`. It:

- creates an empty, depth-one child Session through `parent.ctx.agents`;
- records the real Work preset id, parent Session, seed boundary, workspace,
  and delegation depth in the child header;
- mounts one complete preset inside DSH's unpublished `setup()` transaction;
- calls the contract/controller-owned synchronous publication validator at the
  DSH commit point; and
- returns the sole `AgentHandle` lifecycle capability to its caller.

It never calls `composeFrom(parent)`, never seeds the RP transcript, and never
uses `recompose()` on a Session with history. Mount, setup, cancellation, or
publication validation failures are rolled back by the DSH creation
transaction. The caller must dispose the returned handle.

`createFixedWorkPresetProvider()` builds an inert DSH one-shot provider fixed to
one governed preset, tool ceiling, baseline fingerprint, and preset
fingerprint. Multiple instances implement spawn-time selection without letting
a model pass a preset id or path. The provider preserves the DSH descriptor,
delegated policy, cancellation, result-folding, and idempotent disposal
semantics; it deliberately advertises no per-request composition capabilities
and no continuable path.

Every published run keeps the standard DSH `parentSession` lineage and appends
the one-shot `subagent/descriptor` before the first step. DSH rc.7 can therefore
list it in the parent Session's native subagent catalog and open the persisted
conversation through the exact `openSubagent({ parentSessionId, childSessionId,
mode: 'one-shot' })` address. MistyMoon does not copy child transcripts into a
custom HTTP endpoint, workspace file, Persona, Memory, or parent prompt, and the
opened one-shot Session remains read-only.

`createGovernedWorkPresetProvider()` is the narrow seam from the pure contract
package into that fixed provider. Its caller supplies a synchronous
`resolvePublication()` function, normally backed by `SharedBaselineRegistry`,
`WorkPresetResolver`, and `prepareWorkActivationPublication()`. The Adapter:

- snapshots only path-free fingerprints, the native preset id, effective tool
  allowlist, and fixed model route;
- applies provider/model/reasoning through DSH's public model-selection helper;
- accepts only absent or identical per-request provider/model values; and
- calls `resolvePublication()` again at the unpublished commit point, rolling
  back the child if the governance fingerprint or effective surface changed.

The pure publication function rejects incompatible policy before DSH creation.
This Adapter neither reads manifests nor provisions preset files, and the
publication snapshot contains no prompt text, workspace path, Persona, Memory,
credential, or parent transcript.

`RpWorkDelegationRuntime` is the product-plane deep module. It publishes the
qualified Flash/max foreground adapter, accepts only a top-level
`mistymoon-rp-host-v2`, folds the Owner-governed profile revision, and shares a
workspace-keyed lease across both routes and all RP Host Sessions. A lease is
held through `dispose()`, so two activations cannot write the same workspace in
parallel. Child tools exclude Memory, final-reply, delegation/control,
workflow, and release surfaces.

Every product run also passes through the `WorkReportV1` consumption boundary.
The runtime appends a model-visible, versioned JSON contract to the delegated
task, accepts exactly one text block with no Markdown wrapper, rejects unknown
fields and bounded-field violations, and exposes the validated report through
`SubagentResult.structured`. A completed child with malformed output is changed
to `stopReason: error` with a neutral diagnostic; aborted, failed, refused, and
max-token partial output is never parsed or promoted to a report. DSH reasoning
blocks may accompany the single report block internally, but the consumption
boundary removes every reasoning block from completed and partial results before
they can be delivered to the RP Host. This boundary does not copy the child
transcript and does not make Work facts available to Persona or Memory.

The package is exported and loaded by `cordis.patch.yml` for the Owner-approved
Flash-only launch after Flash/max passed 15/15. Pro/max was paused after 3/15
because of balance risk and is neither registered nor exposed by the RP Host.
It never installs a real Work preset by itself. J-Space remains disabled unless
an explicit deployment opts into the still-experimental profile.

The same fixed `mistymoon_code_flash` provider can freeze an Owner-selected DSH
provider/model pair for each future fresh activation. The Settings Host builds
a credential-free catalog from live `listProviders()`, `listModels()`, and
`resolveCallConfig(... max)` results, then persists only the exact pair, fixed
reasoning, qualification, and revision in the private `work-model.json`.
Direct DeepSeek Flash remains the qualified default; every other pair requires
an explicit save confirmation and remains experimental until independently
qualified. OpenCode Go is one such optional pair rather than a special command
or client. MistyMoon never owns provider URLs, credentials, subscriptions,
balances, or model directories. Missing registration or provider failure is
fail-loud and never falls back to a different route or child.

Phase 0 integration tests provision the versioned Anchored Standard
compatibility preset only into fresh temporary DSH rc.7 Homes, restart the
official headless runtime, and capture the actual prompt, tools, runtime
context, model-visible log, request header, and rollback behavior. A separate loopback capture
uses DSH's public LLM seam and official DeepSeek Adapter to verify the wire
requests for Flash/high, Flash/max, and Pro/max. A deployment that disables
thinking fails before transport, and a missing `deepseek-official` route fails
with `NO_ADAPTER`; no prompt prose is used to imitate reasoning effort.
