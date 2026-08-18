# `@mistymoon/dsh-memory`

This plugin owns MistyMoon's private cross-session companion memory. Its current interface recognizes explicit owner requests, persists one confirmed record per source DSH message, ranks confirmed records lexically, and appends the exact recall snapshot through DSH's `agent/pre-step` waterfall.

Seven DSH-native tools govern the archive. `memory_list`, `memory_replace`, and `memory_forget` manage confirmed records. `memory_candidate_propose`, `memory_candidate_list`, `memory_candidate_approve`, and `memory_candidate_reject` provide an owner-review queue for inferred facts. Pending and rejected candidates never participate in recall; approval appends a new confirmed record linked to its source candidate. A shared Owner Eligibility service gates every tool through DSH's monotonic tool guard, so agentless, delegated, unauthenticated, ended-turn, and stale-seed calls fail before archive access. Their append-only events make authorized changes auditable and recoverable without keeping retired content in recall.

The package also exposes a read-only adapter for the pre-DSH MistyMoon SQLite `memories` table. Migration imports only rows whose old status is `confirmed`; it never copies conversations, persona data, events, graphs, embeddings, candidates, superseded rows, or forgotten rows. Deterministic legacy source ids make reruns idempotent.

The archive is transactional v2 JSONL under the private MistyMoon home. Each logical mutation is one hash-linked transaction, including candidate approval and its resolution. An adjacent content-free durability checkpoint detects complete tail removal. Writers take a bounded cross-process lease, re-read the authoritative generation, append and fsync one transaction, update the checkpoint, and only then publish the new in-process view.

Valid v1 archives open as `migration-required`; damaged archives open as `quarantined`. Both states disable recall and mutation without blocking the surrounding DSH Agent turn. The local maintenance interface and `pnpm memory:maintenance` CLI are read-only by default: migration and trailing-tail recovery require a content-free plan, exact source digest, unexpired token, exact backup, and a separate `apply`. Interior corruption produces only `restore-required`; it is never skipped or guessed. Generated backups have a bounded retention ceiling and are never deleted automatically. A read-only rollback rehearsal checks the current v2 generation and exact v1 backup before the documented stop-and-restore procedure.

The writer uses `proper-lockfile@4.1.2` as its MIT cross-process lease provider. Mutations re-read under the lease and publish the in-memory snapshot only after append, file sync, structural replay, checkpoint publication, and successful lease release. Timeout, compromise, and release failures have stable fail-closed errors.

This archive remains separate from DSH session persistence: DSH sessions are authoritative for conversations, while the Memory archive carries selected cross-session facts. Recall snapshots use `source.kind = plugin` and `plugin = mistymoon-memory`; the agent loop therefore persists the exact model-visible text as a native `user/message` before dispatch.

On Windows, Node can fsync archive and backup files but returns `EPERM` for directory-handle fsync. Maintenance therefore reports `directoryDurability: unsupported-platform` after file fsync, atomic rename, checkpoint publication, and full reopen verification. A sudden power loss during the narrow rename window may require restoring the exact backup; ordinary process failure and partial writes remain fail-closed.

Current limitations:

- The current `local-dsh-host-rpc` authority supports only the default loopback Web single-Owner deployment. Other channels remain fail-closed until they supply an authenticated authority adapter.
- Candidate creation currently occurs through a DSH tool call. A background post-response extraction provider and a dedicated visual review panel are not active.
- Recall is lexical. Embeddings and reranking remain optional future adapters.
- There is no dedicated memory-management Web panel yet; confirmed-memory and candidate governance currently use DSH tools.
- Imported batches do not yet have a rollback command. Individual imported memories remain forgettable through the normal append-only tool.
