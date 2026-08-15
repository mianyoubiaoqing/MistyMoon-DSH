# Repository rules

MistyMoon is an out-of-tree DeepSeek Harness plugin suite. New behavior belongs in MistyMoon plugins or documented public DSH extension points; do not carry private patches against DeepSeek Harness.

## Privacy

- Never copy owner persona, memory, credentials, sessions, logs, migration databases, or diagnostics into this repository.
- Only `personas/template` and `personas/example` assets may be published.
- Tests and snapshots use neutral generated fixtures. They never read `D:\ai\MistyMoon` or a real DSH home.
- Run `pnpm audit:publication` before staging, committing, packaging, or publishing.

## Engineering

- Use ESM, strict TypeScript, explicit package interfaces, and Cordis lifecycle effects where a registration needs disposal.
- Preserve DSH's model-visible/logged invariant: later persona and memory projections must be reconstructable from the DSH session log.
- Treat Windows subprocess ownership as explicit state. A launcher stops only processes it started.
- Add public-interface tests before implementation and keep package build smokes separate from source tests.
