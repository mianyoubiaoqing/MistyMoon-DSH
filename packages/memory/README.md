# `@mistymoon/dsh-memory`

This plugin owns MistyMoon's private cross-session companion memory. Its current interface recognizes explicit owner requests, persists one confirmed record per source DSH message, ranks confirmed records lexically, and appends the exact recall snapshot through DSH's `agent/pre-step` waterfall.

Seven DSH-native tools govern the archive. `memory_list`, `memory_replace`, and `memory_forget` manage confirmed records. `memory_candidate_propose`, `memory_candidate_list`, `memory_candidate_approve`, and `memory_candidate_reject` provide an owner-review queue for inferred facts. Pending and rejected candidates never participate in recall; approval appends a new confirmed record linked to its source candidate. A shared Owner Eligibility service gates every tool through DSH's monotonic tool guard, so agentless, delegated, unauthenticated, ended-turn, and stale-seed calls fail before archive access. Their append-only events make authorized changes auditable and recoverable without keeping retired content in recall.

The package also exposes a read-only adapter for the pre-DSH MistyMoon SQLite `memories` table. Migration imports only rows whose old status is `confirmed`; it never copies conversations, persona data, events, graphs, embeddings, candidates, superseded rows, or forgotten rows. Deterministic legacy source ids make reruns idempotent.

The archive is append-only JSONL under the private MistyMoon home. It is separate from DSH session persistence: DSH sessions remain the authority for conversations, while this archive carries selected cross-session facts. Recall snapshots use `source.kind = plugin` and `plugin = mistymoon-memory`; the agent loop therefore persists the exact model-visible text as a native `user/message` before dispatch.

Current limitations:

- The current `local-dsh-host-rpc` authority supports only the default loopback Web single-Owner deployment. Other channels remain fail-closed until they supply an authenticated authority adapter.
- Candidate creation currently occurs through a DSH tool call. A background post-response extraction provider and a dedicated visual review panel are not active.
- Recall is lexical. Embeddings and reranking remain optional future adapters.
- There is no dedicated memory-management Web panel yet; confirmed-memory and candidate governance currently use DSH tools.
- Imported batches do not yet have a rollback command. Individual imported memories remain forgettable through the normal append-only tool.
