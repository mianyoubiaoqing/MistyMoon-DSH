# MistyMoon for DeepSeek Harness

MistyMoon is a local-first long-term companion assembled as external DeepSeek Harness plugins. This repository contains only the plugin suite, a neutral persona template, and a neutral example. Owner personas, memories, credentials, session logs, migrations, and runtime data belong under the user's DSH home and must never enter this repository.

## Current foundation slice

- `@mistymoon/dsh-foundation` initializes a private persona exactly once, validates its versioned JSON, never overwrites owner edits, and replaces DSH's standard persona slot through `system-prompt/assemble`. Persona version 2 stores identity, relationship rules for the owner/familiar people/strangers, communication instructions, reference dialogs, and response-length guidance; version 1 files are upgraded in memory and are written as version 2 after the next settings save.
- `@mistymoon/dsh-memory` stores explicit owner requests such as `请记住：……` in private append-only JSONL, deduplicates them by DSH message id, logs recalled context as source-attributed DSH messages, and supplies DSH-native list/replace/forget tools.
- The repository root is the installable `@mistymoon/dsh` bundle. It exports the foundation and memory plugins as package subpaths and does not patch DSH source.
- The root package also provides a loopback-only Host settings API and a Web client tab under **Settings → Plugins → MistyMoon**. It edits the private persona and per-request memory recall limit without exposing owner files to non-loopback clients.
- DSH's own `plugin --profile web add` command appends the suite after the official base and Web layers; MistyMoon never hand-writes the profile manifest.
- `audit:publication` rejects private personas, databases, session logs, environment files, and non-placeholder credentials before publication.

The profile currently pins DSH `0.1.0-rc.6`. DSH records the final rendered persona in each changed `request/header`; every recalled-memory snapshot is an ordinary logged `user/message`, so sent requests remain reconstructable from the native session log. The settings page is available only from a loopback browser because it can read and replace private persona data. Later milestones add a visual memory review panel, QQ/NapCat channels, proactive interaction, Windows Launcher packaging, mobile-over-SSH, and optional Presence/Live2D rendering.

## Development

Requires Node.js `^22.19.0 || >=24.0.0` and pnpm 11.7.

```powershell
pnpm install
pnpm check
```

`pnpm check` runs strict type checking, unit tests, a clean package build, a plain-Node Cordis plugin smoke, and the publication audit.

## Development preview

The preview uses the exact DSH `0.1.0-rc.6` runtime pinned in this workspace. On Windows its private home defaults to `%LOCALAPPDATA%\MistyMoon\dsh`; set `MISTYMOON_DSH_HOME` to override it.

```powershell
pnpm preview:install
pnpm preview:smoke
pnpm preview:start
```

`preview:start` rebuilds and reinstalls the local packages, then runs the MistyMoon Web profile in the foreground. Forward Web arguments after `--`, for example `pnpm preview:start -- --port 3081`. The current preview supplies private persona projection, explicit-memory recall, append-only memory governance, and a local Web settings page; automatic consolidation, a visual memory review panel, and communication channels are later milestones.

## Install into DSH

From a DeepSeek Harness source checkout, build this repository once and install its root bundle through the DSH CLI:

```powershell
cd D:\ai\MistyMoon-DSH
pnpm install
pnpm build

cd D:\ai\deepseek-harness
pnpm dsh plugin --profile web add D:\ai\MistyMoon-DSH
pnpm dsh --profile web
```

This is an ordinary out-of-tree DSH plugin installation. The generated Web profile contains one external dependency, `@mistymoon/dsh`, and DSH remains responsible for creating and reconciling its manifest. MistyMoon does not modify the DeepSeek Harness checkout.

The root package runs `prepare` for Git installations and `prepack` for npm or tarball releases, producing the bundled foundation and memory `lib/` entry points. A future registry release can therefore be installed with `dsh plugin --profile web add @mistymoon/dsh`; a Git-hosted installation must follow DSH's documented pnpm `allowBuilds` approval and should pin a commit.

## Legacy memory migration

Preview an old MistyMoon SQLite database without changing either database:

```powershell
pnpm preview:migrate-memory -- D:\path\to\legacy.db
```

After reviewing the counts and warnings, explicitly copy eligible confirmed memory text into the private preview home:

```powershell
pnpm preview:migrate-memory -- D:\path\to\legacy.db --apply
```

The source is always opened read-only. Rerunning `--apply` is idempotent. The command does not read or copy old persona, sessions, events, graphs, vector indexes, credentials, candidate memories, superseded memories, or forgotten memories.

## Private persona location

The bundle passes `dshHomePath('mistymoon')` to the foundation plugin. First start creates `persona/persona.json` below that private home from the neutral template. Confirmed explicit memories are appended to `memory/memories.jsonl` beside it. Edit only the private persona copy, either directly or through **Settings → Plugins → MistyMoon**; subsequent installs and starts preserve private data. The plugin compiles the private persona into DSH's standard persona prompt contribution, so the richer format does not require a DeepSeek Harness source patch.

## Licensing

This repository is MIT licensed. DeepSeek Harness and runtime dependencies retain their own licenses. OwO-Desktop, Live2D Cubism components, models, fonts, voices, and other third-party assets are not included; they require separate license review and explicit redistribution permission before integration.
