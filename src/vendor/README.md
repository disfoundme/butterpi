# `src/vendor/dsh` — vendored dsh-TUI renderer

Verbatim copy of the reachable module closure of dsh-TUI, used as butterpi's
Ink/React rendering stack, plus the deliberate butterpi divergences listed
below. dsh-TUI upstream is replaced as a dependency; its UI layer is compiled
in-tree from these sources.

## Source

- Repo: `dsh-TUI` (local checkout `/home/ispurez/项目/dsh-TUI`)
- Commit: `f2ca43a08e82f0a571fac185443b52608e921ed8` (HEAD at copy time, 2026-09-28)
- Package: `@deepseek-harness-tui/dsh-tui@0.11.1`

## What was copied

542 files — the transitive relative-import closure of two seeds:

- `src/screens/Chat.tsx` — the chat screen (the component butterpi mounts)
- `src/ui.ts` — the public rendering facade (`render`, `createRoot`,
  `ThemeProvider`, `Box`, `Text`, `ScrollBox`, `AlternateScreen`, `useInput`, …)

Layout mirrors upstream `src/` exactly: `ink/` (custom Ink fork + reconciler),
`native-ts/` (Yoga layout), `components/`, `screens/`, `dsh-adapter/`,
`adapter/`, `hooks/`, `utils/`, `terminal-utils/`, `sessions/`, `trajectory/`,
plus top-level `*Prefs.ts`/`i18n.ts`/etc. One extra file not reachable via
imports but required at compile time was copied manually:
`dsh-adapter/renderer-shims.d.ts` (global JSX intrinsic declarations for
`ink-box`/`ink-text`/… and `declare module` augmentations of the cordis/dsh
stubs).

## NOT copied (deliberately)

- `dsh-ecosystem-spec/` — uninitialized git submodule upstream; its
  `#dsh-ecosystem-spec/*` imports are stubbed (see below).
- `vendor/dsh-std/`, `dsh-auth/` — also uninitialized submodules.
- Files outside the import closure (plugin entry `index.ts`, adapter barrel
  `index.ts` files, `scripts/`, tests) — they pull in the Cordis plugin host
  machinery that butterpi replaces.

## Compilation

Single `tsconfig.json` covers app + vendor: `module ESNext` +
`moduleResolution Bundler` + `jsx react-jsx` (a two-config split was deemed
unnecessary — bundler resolution accepts the `.js` ESM suffixes both codebases
already use, and the emitted graph is one tree under `dist/`).
`strict: true` is kept on deliberately: several discriminated-union
narrowings in the vendored code only hold when `strictNullChecks` is on.
dsh-TUI's own relaxed-flag block (`noImplicitAny`, `noUncheckedIndexedAccess`,
`exactOptionalPropertyTypes`, `noImplicitOverride`, `noFallthroughCasesInSwitch`,
`noUnused*`) is applied globally instead.

## Stubs (`vendor-stubs/`)

Vendored files import upstream packages that do not exist in this repo. Each is
a `file:` dependency (npm links them into `node_modules`, so both `tsc` and
Node resolve identically):

`vendor-stubs/@deepseek-ai/{cordis,dsh-agent,dsh-agent-instructions,
dsh-atomic-write,dsh-commands,dsh-invariants,dsh-llm,dsh-session,
dsh-session-persistence-jsonl,dsh-skill,dsh-system-prompt,dsh-user-approval,
dsh-user-questions,dsh-workspace,schemastery}`,
`vendor-stubs/@dsh-std/{command,core,manifest,messages,presentation,storage}`,
`vendor-stubs/sharp`, `vendor-stubs/dsh-ecosystem-spec/`.

`index.js` exports a self-referential callable/constructible Proxy as every
named/default export — safe for `import`, `new`, `extends`, `X.field`.
`index.d.ts` pairs each name with `declare const X: any` + a generic-with-
defaults `type X = any`. Exceptions where `any` is too permissive for upstream
control-flow narrowing:

- `cordis`: `Context`/`Fiber`/`Service` are mergeable `interface`s (vendored
  `declare module '@deepseek-ai/cordis'` blocks augment `Context`); `Context`
  has `is(x): x is Context` and key-generic `get<K>(): this[K] | undefined`
  (mirrors real cordis semantics; `any` returns would break `??=` narrowing).
- `dsh-agent`: `Agent`/`AgentHandle`/`AssistantStreamFrame` are interfaces with
  the fields the projection code narrows on (`attemptId: string`, `dispose():
  Promise<void>`, …).
- `dsh-llm`/`dsh-session`: extra `MessageSourceMap`/`SessionEventMap`
  interfaces for `declare module` merges; `SessionEvent<A,B>` is generic.
- `schemastery`: `Schema` is type+value (`Schema<T>` and `Schema.string()`).
- `sharp`: default `any` only — vendored code loads it dynamically and treats
  absence as "no image pipeline".

`#dsh-ecosystem-spec/*` resolves via `package.json#imports` to
`vendor-stubs/dsh-ecosystem-spec/profile-definitions.{js,d.ts}` — the real
module surface (`DECISION_EVENTS`, `registerProfileProtocols`,
`validateTuiChannel*`, `TuiChannel*`, `tuiChannelDefinition`, …) as `any` stubs.

## butterpi divergence from upstream

The vendored tree is intentionally not a byte-for-byte mirror. Beyond the
cosmetic rebrand (`ButterArt`, the `✦ butterπ` wordmark, tips), these edits
decouple butterpi from the DSH ecosystem. Re-apply them when re-syncing:

- **Storage moved off the DSH namespace.** `utils/paths.ts` sets `DATA_DIR` to
  `~/.butterpi` (was `~/.dsh-tui`); the literal `~/.dsh-tui` path strings across
  the tree (i18n hints, warnings) and `dsh-adapter/compat/sessionLog.ts` follow
  it. butterpi and dsh-TUI no longer share on-disk state.
- **The dsh-TUI "one-key star" feature is disabled.** `utils/keymap.ts` drops
  the default `alt+s` binding, and `screens/Chat.tsx` turns `runStarAction` /
  `openStarPage` into no-ops (the fixture seam still runs). `starAction.ts`
  (which ran `gh api PUT user/starred/ccch1mneyyy/dsh-TUI`) is deleted, so no
  code path can star or open the DSH repository.
- **`dsh-working-activity` is vendored, dependency removed.**
  `components/activityFrames.ts` now carries the frame-preset table inline and
  `activityConfig.ts` carries the config parser; `activityPrefs.ts` uses a local
  structural `MountedActivityConfig`. `dsh-working-activity` is gone from
  `package.json`.
- **`BUTTERPI_*` env precedence** lives in `src/env.ts`, imported first by
  `src/index.ts`: each `BUTTERPI_*` aliases onto the matching `DSH_TUI_*` name
  before the vendored renderer reads it.

Deliberately left as-is (inert, unreachable from butterpi's mount):
`update.ts`'s npm self-update path (`@deepseek-harness-tui/dsh-tui`) and the DSH
session/plugin-host compat roots (`$DSH_HOME`, `~/.dsh`).

## Known unimplemented / non-functional areas

Anything that touches the stubbed upstream at *runtime* is inert: channel
creation (`dsh-adapter/channel.ts` needs a real cordis Context), host service
mounts, plugin host, sessions persistence, `sharp` image pipeline (text
fallback), migrate-from-other-CLIs, workspace registry, LLM calls. butterpi's
own `PiChannel` (Phase 2) is intended to implement `adapter/channel/ui-policy.ts`'s
`ChannelUi` directly rather than instantiate these.

Real npm deps the vendored tree needs are in `package.json` (marked, yaml,
cli-highlight, sixel, lovely-mermaid, wrap-ansi, etc.). `typescript@^6` is
pinned (upstream uses 6.0.3; union narrowing differs from 5.x).