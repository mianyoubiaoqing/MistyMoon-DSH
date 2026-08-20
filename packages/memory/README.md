# `@mistymoon/dsh-memory`

This plugin owns MistyMoon's private cross-session companion memory. Every public archive operation requires a host-constructed `MemoryAccessContextV1`; model tool arguments cannot choose Owner, authority, scope, or disclosure policy. New candidates and records use domain schema v2 and reference an immutable Observation committed in the same storage transaction. They retain exact Owner/scope, memory kind, recorded time, optional validity bounds, visibility, source, and append-only revision state.

Seven DSH-native tools govern the archive. `memory_list`, `memory_replace`, and `memory_forget` manage confirmed records. `memory_candidate_propose`, `memory_candidate_list`, `memory_candidate_approve`, and `memory_candidate_reject` provide an owner-review queue for inferred facts. Pending and rejected candidates never participate in recall; approval appends a new confirmed record linked to its source candidate. A shared Owner Eligibility service gates every tool through DSH's monotonic tool guard, so agentless, delegated, unauthenticated, ended-turn, and stale-seed calls fail before archive access. Their append-only events make authorized changes auditable and recoverable without keeping retired content in recall.

The package also exposes a read-only adapter for the pre-DSH MistyMoon SQLite `memories` table. Migration imports only rows whose old status is `confirmed`; it never copies conversations, persona data, events, graphs, embeddings, candidates, superseded rows, or forgotten rows. Deterministic legacy source ids make reruns idempotent.

The archive is transactional v2 JSONL under the private MistyMoon home. Each logical mutation is one hash-linked transaction, including candidate approval and its resolution. An adjacent content-free durability checkpoint detects complete tail removal. Writers take a bounded cross-process lease, re-read the authoritative generation, append and fsync one transaction, update the checkpoint, and only then publish the new in-process view.

Legacy domain-v1 archives open as `scope-migration-required`, including already transactional storage-v2 generations. They cannot recall or mutate until a content-free plan explicitly supplies Owner, authority, target scope, default memory kind, and the `legacy-created-at` recorded-time policy. Apply is bound to the exact source digest, expiring token, and exact backup, then converts Observation plus scoped records atomically without classifying content. Damaged archives remain `quarantined`; interior corruption produces only `restore-required`. Generated backups have a bounded retention ceiling and are never deleted automatically.

The writer uses `proper-lockfile@4.1.2` as its MIT cross-process lease provider. Mutations re-read under the lease and publish the in-memory snapshot only after append, file sync, structural replay, checkpoint publication, and successful lease release. Timeout, compromise, and release failures have stable fail-closed errors.

This archive remains separate from DSH session persistence: DSH sessions are authoritative for conversations, while the Memory archive carries selected cross-session facts. Recall snapshots use `source.kind = plugin` and `plugin = mistymoon-memory`; the agent loop therefore persists the exact model-visible text as a native `user/message` before dispatch.

Recall hard-filters confirmed state, exact Owner, authority, exact scope, current validity, and visibility before lexical ranking. Confidential data is eligible only when both the trusted channel policy is `owner-confidential` and the authenticated current request has explicit confidential-recall intent. Settings UI uses the Memory-owned loopback governance facade, so browser payloads cannot select or expand these fields.

On Windows, Node can fsync archive and backup files but returns `EPERM` for directory-handle fsync. Maintenance therefore reports `directoryDurability: unsupported-platform` after file fsync, atomic rename, checkpoint publication, and full reopen verification. A sudden power loss during the narrow rename window may require restoring the exact backup; ordinary process failure and partial writes remain fail-closed.

Post-response candidate extraction now uses a single-active Provider registry. The Provider receives only authenticated Owner evidence selected from the completed top-level turn, returns strict untrusted drafts, and cannot access the Archive. Memory atomically records every source batch as pending with a provider receipt; failures are bounded and cannot fail the Owner turn. No extraction Provider is bundled or enabled by default. A future model-backed Adapter must run through a separately logged DSH Session and return its request/response receipt.

Pending candidates can be assessed against active records through a deterministic, explainable conflict seam. Duplicate/conflict results never mutate governance state. Approval fails closed until the Owner chooses `keep-both` or selects an assessed active memory to supersede; supersession appends the confirmed replacement, candidate resolution, and old-version tombstone in one transaction.

Current limitations:

- The current `local-dsh-host-rpc` authority supports only the default loopback Web single-Owner deployment. Other channels remain fail-closed until they supply an authenticated authority adapter.
- The extraction seam and post-response consumer are active, but no local-model or remote Provider is bundled; candidates can still be proposed through the governed DSH tool.
- Recall is lexical. Embeddings and reranking remain optional future adapters.
- There is no dedicated memory-management Web panel yet; confirmed-memory and candidate governance currently use DSH tools.
- Imported batches do not yet have a rollback command. Individual imported memories remain forgettable through the normal append-only tool.
