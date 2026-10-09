# 🧈 butterpi

A fullscreen TUI frontend for the [pi coding agent](https://github.com/badlogic/pi-mono)
(`@earendil-works/pi-coding-agent`), inspired by
[dsh-TUI](https://github.com/ccch1mneyyy/dsh-TUI) — the fullscreen interface for DeepSeek Harness.

butterpi embeds pi **in-process** through its SDK (`createAgentSessionRuntime`) and renders with
`pi-tui` in **alt-screen fullscreen mode**: a scrollable transcript, a docked editor, and a
live status bar — while reusing pi's own battle-tested components (tool-execution cards,
selectors) so tool rendering, diffs, images, and extensions behave exactly like stock pi.

The markdown/message layer is re-dressed in **dsh-TUI's visual conventions**
(`src/dsh-markdown.ts`, `src/messages.ts`): `▎` quote gutters, ` ```lang ` opening fences
without closing fences, gold codespans, depth-aware ordered-list markers (`1.` `a.` `i.`),
OSC-8 label-only links, `❯ ` user prompts, `● ` assistant gutter, `⚓ Thinking` fold labels.

## Features

- **Alt-screen fullscreen layout** — transcript scrollview (mouse wheel, search `Ctrl+Shift+F`,
  jump-to-end indicator), docked prompt editor, hardware cursor, mouse select/copy.
- **Rounded editor box** — `╭─╮│╰─╯` chrome with an accent `❯` prompt that dims while working
  (dsh PromptInput style).
- **Status bar HUD** — dsh dot-pulse spinner `·•●•` + random verb, elapsed timer,
  `provider/model:thinking`, context-window gauge `[████░░░░] %`, rolling tokens/sec,
  session token/cost totals, git branch, session name.
- **Toast notifications** — non-blocking info/warning/error popups above the status bar.
- **Queued-message lane** — pending steer/follow-up messages shown above the editor.
- **Slash commands** — `/model` (type-to-search across providers, fuzzy match on
  provider/id/name) `/thinking` `/theme` `/resume` `/new` `/fork` `/tree` `/compact`
  `/export` `/copy` `/name` `/session` `/reload` `/trust` `/timeline` `/help` `/quit`,
  reusing pi's own selector components; extension commands and prompt templates pass through.
- **`@` file completion + `/` command completion** in the editor.
- **`!cmd` / `!!cmd`** inline bash with live output cards (pi-compatible).
- **pi extensions supported** — `ctx.ui` dialogs, notifications, statuses, widgets.
- All pi session machinery: resume, fork, tree navigation, compaction, auto-retry display.

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
```

## Configuration

butterpi keeps its UI state under `~/.butterpi` (theme, language, working-activity
preset, session-view prefs) — deliberately separate from dsh-TUI's `~/.dsh-tui`,
so the two never share on-disk state.

Environment variables use the `BUTTERPI_*` prefix and take precedence over the
legacy `DSH_TUI_*` spelling (aliased onto it at startup by `src/env.ts`): e.g.
`BUTTERPI_THEME=dark`, `BUTTERPI_LANG=en`, `BUTTERPI_HOME=…`.

The dsh-TUI "star this project" action (`/star`, Alt+S) is disabled, and
`dsh-working-activity` is vendored rather than depended on — butterpi makes no
outbound calls to the DSH ecosystem.

## Keys

| Key | Action |
|---|---|
| Enter | send (queues as follow-up while running) |
| Esc | interrupt / close overlay / dequeue |
| Ctrl+P | cycle model · Ctrl+L selector |
| Shift+Tab | cycle thinking · Ctrl+T toggle thinking blocks |
| Ctrl+O | expand tool output · Ctrl+X copy last reply |
| Alt+Enter | send as steer · Alt+Up restore queued |
| Ctrl+C / Ctrl+D | clear editor / exit |

## How it works

```
AgentSessionRuntime (SDK) ──► AgentSessionEvent stream ──► Transcript (pi's message components)
                                    │
                                    └► StatusBar / ToastBar / pending queue ──► TuiAltScreen
```

pi's `exports` map only exposes the root entry, so butterpi resolves a few internal
modules (`theme.js`, `keybindings.js`, built-in tool renderers) by file URL at runtime
(`src/internals.ts`). Theme/keybinding singletons are registered on both the app's and
pi's nested `pi-tui` copies.

Because it renders what the model emits, butterpi appends a short capability note to
the model's system prompt — Markdown, tables, LaTeX math (`$…$` / `$$…$$`) and
Mermaid fenced blocks drawn as box-drawing art — so models actually use those forms.
It is scoped to butterpi's own runtime and never touches the `pi` CLI or its global
config; `--append-system-prompt` still applies alongside it, and `--no-harness-notes`
turns the note off.

## Known limitations

- Print/JSON/RPC modes are not implemented — butterpi is interactive-only; use `pi -p` for scripting.
- Extension `setFooter`/`setHeader`/`setEditorComponent` overrides are accepted but currently no-ops.
- `/settings`, `/login`, `/share`, `/bug`, `/import`, `/scoped-models` are not yet implemented —
  pi's built-in variants live inside InteractiveMode, which butterpi replaces.

## License

[MIT](./LICENSE) © 2026 butterpi contributors.

butterpi vendors and adapts code from other projects, whose notices are
retained in [NOTICE.md](./NOTICE.md):

- **dsh-TUI** (<https://github.com/ccch1mneyyy/dsh-TUI>) — MIT. The Ink/React
  rendering stack under `src/vendor/dsh/` is a verbatim copy of its module
  closure; the markdown/message layer is adapted from it.
- **pi / pi-mono** (<https://github.com/badlogic/pi-mono>) — MIT, © 2025 Mario
  Zechner. Rendering components are reused/adapted and
  `src/vendor/dsh/terminal-utils/latex.ts` is copied verbatim.
- **dsh-ui-whale** (<https://github.com/lhh010/dsh-ui-whale>) — BSD 3-Clause,
  via dsh-TUI (whale sprite frames and idle behaviors).
- **dsh-anchored-standard** — MIT, via dsh-TUI.
- **dsh-working-activity** — BSD 3-Clause, © 2026 chimney (ccch1mneyyy).

All other dependencies ship their own license texts in `node_modules/`.
