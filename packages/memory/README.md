# `@mistymoon/dsh-memory`

This plugin owns MistyMoon's private cross-session companion memory. Its current interface recognizes explicit owner requests, persists one confirmed record per source DSH message, ranks confirmed records lexically, and appends the exact recall snapshot through DSH's `agent/pre-step` waterfall.

Three DSH-native tools govern the archive: `memory_list` reviews active or historical records, `memory_replace` appends a corrected value while superseding the old record, and `memory_forget` retires a value. Mutation tools are described to run only on a clear owner request. Their append-only events make changes auditable and recoverable without keeping retired content in recall.

The package also exposes a read-only adapter for the pre-DSH MistyMoon SQLite `memories` table. Migration imports only rows whose old status is `confirmed`; it never copies conversations, persona data, events, graphs, embeddings, candidates, superseded rows, or forgotten rows. Deterministic legacy source ids make reruns idempotent.

The archive is append-only JSONL under the private MistyMoon home. It is separate from DSH session persistence: DSH sessions remain the authority for conversations, while this archive carries selected cross-session facts. Recall snapshots use `source.kind = plugin` and `plugin = mistymoon-memory`; the agent loop therefore persists the exact model-visible text as a native `user/message` before dispatch.

Current limitations:

- The preview assumes the Web user is the owner. Audience-specific disclosure enforcement lands with channel identity.
- Only explicit confirmed memories are accepted. Automatic candidate extraction and review are not active.
- Recall is lexical. Embeddings and reranking remain optional future adapters.
- There is no dedicated memory-management Web panel yet; governance currently uses DSH tools.
- Imported batches do not yet have a rollback command. Individual imported memories remain forgettable through the normal append-only tool.
