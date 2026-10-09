# 🧈 butterpi

A fullscreen TUI frontend for the [pi coding agent](https://github.com/badlogic/pi-mono)
(`@earendil-works/pi-coding-agent`), built on the visual language of
[dsh-TUI](https://github.com/ccch1mneyyy/dsh-TUI).

butterpi embeds pi **in-process** through its SDK (`createAgentSessionRuntime`) and drives a
**vendored copy of the dsh-TUI renderer** (`src/vendor/dsh/`, an Ink/React alt-screen stack):
the dsh Chat screen — scrollable transcript, docked composer, dot-pulse working spinner,
status HUD, toasts, session rail — renders on top of `PiChannel`
(`src/pi-channel.ts`), a thin adapter that projects pi's `AgentSessionEvent` stream into
dsh-TUI's channel contract (rows, tokens, live tokens/sec, pending queue, prefs).
Slash commands, `@` file completion and `!cmd` inline bash all flow through the same
adapter, so pi extensions, skills and prompt templates behave like they do in stock pi.

## Features

- **Alt-screen fullscreen layout** — dsh-TUI Chat screen: scrollable transcript with
  mouse wheel + mouse select/copy, docked prompt composer, timeline gutter.
- **Status HUD** — dot-pulse spinner (`·•●•`), provider/model · thinking level, context-window
  gauge, session token totals, cwd + git branch (polled async, never blocks a frame),
  session title/color; `/cost` `/tokens` `/status` for the details.
- **Live tokens/sec** — streaming deltas are windowed and converted with a ~4 chars/token
  estimate (`src/tps.ts`, unit-tested) that refuses to report until the window spans a
  real interval, so it never spikes on the first chunk.
- **Toast notifications** — non-blocking info/warning/error popups above the composer.
- **Queued-message lane** — pending steer/follow-up messages render above the editor;
  Alt+Up pulls the last one back into the composer for editing, and Esc while
  working delivers them immediately (interrupt-and-deliver).
- **Slash commands** — the dsh command set (`/new` `/compact` `/resume` `/rewind` `/tree`
  `/fork` `/trace` `/theme` `/activity` `/lang` `/workspace` `/home` `/doctor` …) plus pi's
  own (`/model` `/thinking` `/effort` `/context` `/skills` `/settings` `/login` `/logout`
  `/import` `/export` `/share` `/bug` `/changelog` `/scoped-models` `/reload` `/trust`
  `/name` `/copy` `/session` `/stats` `/hotkeys`); extension commands, skills and prompt
  templates pass through to pi's dispatcher.
- **`@` file completion + `/` command completion** in the composer; `Ctrl+R` input history search.
- **`!cmd` / `!!cmd`** inline bash with live streaming output cards (`!!` keeps it out of
  the model's context).
- **Transcript search** — `/` in expanded transcript mode opens a less-style search bar
  (`n`/`N` jump between matches).
- **pi extensions supported** — `ctx.ui` select/confirm/input dialogs, notifications and
  status lines render through the dsh dialog/status stores; component-factory surfaces
  (`setWidget`/`custom`/`setFooter`/…) can't render inside the Ink tree and degrade to a
  one-time notice.
- **All pi session machinery** — resume (`-c`/`-r`), fork, rewind, tree navigation,
  compaction with live status row, auto-retry notifications, context window tracking.
- **Workspace ledger** — `/home` / `/workspace` manage per-project sessions across a
  persisted workspace registry.

## Install & run

```sh
npm install
npm run build
./dist/index.js            # or: npm link  →  butterpi
```

Requires Node ≥ 22 and pi credentials configured as usual (`/login`, `auth.json`,
provider env vars, or `models.json`).

```sh
butterpi -c                # continue most recent session
butterpi -r                # session picker
butterpi -m anthropic/claude-sonnet-4-5:high
butterpi --theme light     # force theme; /theme switches at runtime
```

`--print` is rejected outright: butterpi is interactive-only — use `pi -p` for scripting.

## Configuration

Two state directories, deliberately separate:

- **`~/.butterpi`** — the vendored dsh-TUI stack's UI state (theme, language,
  working-activity preset, page-margin and other display prefs), exactly where dsh-TUI
  would keep its own (`~/.dsh-tui`). Set `BUTTERPI_HOME` to relocate it.
- **pi's agent dir** (default `~/.pi/agent`) — pi's own settings, sessions and themes,
  plus butterpi's adapter-side prefs: `butterpi-ui.json` (display prefs set via
  `/settings`), `butterpi-history.json` (input history), `butterpi-workspaces.json`
  (workspace ledger).

Environment variables use the `BUTTERPI_*` prefix and take precedence over the
legacy `DSH_TUI_*` spelling (aliased onto it at startup by `src/env.ts`): e.g.
`BUTTERPI_THEME=dark`, `BUTTERPI_LANG=en`, `BUTTERPI_HOME=…`.

Theme resolution order: `--theme` flag → `BUTTERPI_THEME` env → persisted `/theme`
choice (`~/.butterpi/theme.json`) → OSC 11 terminal-background detection
(`auto` re-detects on every switch). Custom palettes live in `~/.butterpi/themes/*.json`.

The dsh-TUI "star this project" action (`/star`, Alt+S) is disabled, and
`dsh-working-activity` is vendored rather than depended on — butterpi makes no
outbound calls to the DSH ecosystem.

## Keys

Run `/hotkeys` in-app for the full list. The essentials:

| Key | Action |
|---|---|
| Enter | send (queues as follow-up while running) |
| Esc | interrupt (queued messages deliver immediately) / close overlay |
| Alt+Up | pull the last queued message back into the composer |
| Ctrl+C | idle: clear prompt, double-press exits · working: interrupt |
| Ctrl+D | double-press exits |
| Ctrl+R | input history search |
| `/` in expanded transcript | less-style transcript search (`n`/`N`) |
| `!` / `@` / `/` in composer | bash / file completion / command completion |

## How it works

```
AgentSessionRuntime (pi SDK) ──► AgentSessionEvent stream ──► PiChannel
                                    (rows projection · tokens · tps · prefs · workspaces)
                                          │
                                          └► vendored dsh-TUI Chat screen ──► Ink alt-screen renderer
```

`src/runtime.ts` bootstraps pi exactly the way its own `main()` does
(`createAgentSessionServices` / `createAgentSessionFromServices` /
`createAgentSessionRuntime`), so `/new`, `/resume`, `/fork`, `/import` and workspace
switches all behave like pi's. `src/chat-app.tsx` mounts the vendored dsh-TUI
`Chat` screen (`ThemeProvider > AlternateScreen > PageMargin`) and bridges pi's
`ExtensionUIContext` onto the dsh dialog/status stores.

Because it renders what the model emits, butterpi appends a short capability note to
the model's system prompt — Markdown, tables, LaTeX math (`$…$` / `$$…$$`) and
Mermaid fenced blocks drawn as box-drawing art — so models actually use those forms.
It is scoped to butterpi's own runtime and never touches the `pi` CLI or its global
config; `--append-system-prompt` still applies alongside it, and `--no-harness-notes`
turns the note off.

## Known limitations

- Interactive-only; `--print`/RPC modes are rejected — use `pi -p` for scripting.
- pi-tui component-factory extension surfaces (`setWidget`, `custom`, `setFooter`,
  `setHeader`, `setEditorComponent`) can't render inside the Ink tree and are no-ops
  (with a one-time notice).
- pi's own theme system is inactive under the dsh renderer (dsh themes render instead);
  `/theme-pi` still lists pi themes for muscle memory.
- Not backed by the pi SDK (the adapter returns a polite refusal): permission presets,
  agent presets, subagents/background agents, session recap, side questions, MCP status.

## License

[MIT](./LICENSE) © 2026 butterpi contributors.

butterpi vendors and adapts code from other projects, whose notices are
retained in [NOTICE.md](./NOTICE.md):

- **dsh-TUI** (<https://github.com/ccch1mneyyy/dsh-TUI>) — MIT. The Ink/React
  rendering stack under `src/vendor/dsh/` is a verbatim copy of its module
  closure, minimally adapted (star action disabled, `~/.butterpi` state dir).
- **pi / pi-mono** (<https://github.com/badlogic/pi-mono>) — MIT, © 2025 Mario
  Zechner. `src/vendor/dsh/terminal-utils/latex.ts` is copied verbatim.
- **dsh-ui-whale** (<https://github.com/lhh010/dsh-ui-whale>) — BSD 3-Clause,
  via dsh-TUI (whale sprite frames and idle behaviors).
- **dsh-anchored-standard** — MIT, via dsh-TUI.
- **dsh-working-activity** — BSD 3-Clause, © 2026 chimney (ccch1mneyyy).

All other dependencies ship their own license texts in `node_modules/`.