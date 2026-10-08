/**
 * Slash commands — local implementations for butterpi built-ins, plus
 * pass-through to pi's extension commands (handled inside session.prompt()).
 */

import {
	ModelSelectorComponent,
	SessionManager,
	SessionSelectorComponent,
	ThinkingSelectorComponent,
	TreeSelectorComponent,
	UserMessageSelectorComponent,
} from "@earendil-works/pi-coding-agent";
import { Container, SelectList, Text, type Component, type Focusable } from "@earendil-works/pi-tui";
import type { ButterApp } from "./app.js";

type App = ButterApp;

const HELP_TEXT = `butterpi — a fullscreen frontend for the pi coding agent

  Enter        send (queues as follow-up while running)
  ! cmd        run shell command   !! cmd   run without context
  @ path       autocomplete files  / cmd    commands
  Esc          abort / close overlay / dequeue
  Ctrl+P       cycle model         Ctrl+L   model selector
  Shift+Tab    cycle thinking      Ctrl+T   show/hide thinking
  Ctrl+O       expand tool output  Alt+Enter send as steer
  Alt+Up       restore queued msgs Ctrl+C    clear / exit
  Ctrl+D       exit (empty editor) Ctrl+Shift+F search transcript

  /help /model /thinking /theme /resume /new /fork /tree
  /compact /export /copy /name /session /reload /trust /quit
`;

class HelpView extends Container implements Focusable {
	focused = true;
	constructor(private done: () => void) {
		super();
	}
	handleInput(data: string): void {
		if (data === "\x1b" || data === "q" || data === "\r") this.done();
	}
	render(width: number): string[] {
		return HELP_TEXT.split("\n").map((l) => l.slice(0, width));
	}
	invalidate(): void {}
}

/** Returns true if the input was consumed as a butterpi-local command. */
export async function handleSlashCommand(app: App, raw: string): Promise<boolean> {
	const [cmd, ...rest] = raw.slice(1).split(/\s+/);
	const args = rest.join(" ").trim();
	const s = app.session;
	switch (cmd) {
		case "help":
		case "?": {
			app.dialogs.show(new HelpView(() => app.tui.hideOverlay()), { width: "70%" });
			return true;
		}
		case "quit":
		case "exit":
		case "q": {
			await app.shutdown();
			return true;
		}
		case "model": {
			if (args) {
				const found = (s.modelRuntime.getAvailableSnapshot?.() ?? []).find(
					(m: { provider: string; id: string }) => `${m.provider}/${m.id}` === args || m.id === args,
				);
				if (found) {
					await s.setModel(found);
					app.showStatus(`Model: ${found.provider}/${found.id}`);
				} else {
					app.showStatus(`Model not found: ${args}`, "error");
				}
				return true;
			}
			await openModelSelector(app);
			return true;
		}
		case "thinking": {
			if (args) {
				const levels = s.getAvailableThinkingLevels();
				if (levels.includes(args as never)) {
					s.setThinkingLevel(args as never);
					app.showStatus(`Thinking: ${args}`);
				} else {
					app.showStatus(`Invalid level. Options: ${levels.join(", ")}`, "warning");
				}
				return true;
			}
			await openThinkingSelector(app);
			return true;
		}
		case "theme": {
			const names = app.tm().getAvailableThemes();
			const sel = await app.dialogs.select("Theme", names);
			if (sel) {
				const r = app.tm().setTheme(sel);
				if (r && r.success === false) {
					app.showStatus(`Theme failed: ${r.error ?? "unknown"}`, "error");
				} else {
					app.runtime.services.settingsManager.setTheme(sel);
					app.showStatus(`Theme: ${sel}`);
				}
			}
			return true;
		}
		case "resume":
		case "r": {
			await openResume(app);
			return true;
		}
		case "new": {
			const ok = await app.dialogs.confirm("New session", "Start a fresh session?");
			if (ok) await app.runtime.newSession();
			return true;
		}
		case "fork": {
			await openFork(app);
			return true;
		}
		case "tree": {
			await openTree(app);
			return true;
		}
		case "compact": {
			await s.compact(args || undefined);
			return true;
		}
		case "export": {
			try {
				const p = args || undefined;
				const out = p?.endsWith(".jsonl") ? s.exportToJsonl(p) : s.exportToHtml(p);
				app.showStatus(`Exported: ${out}`);
			} catch (err) {
				app.showStatus(`Export failed: ${err instanceof Error ? err.message : err}`, "error");
			}
			return true;
		}
		case "copy": {
			await (app as unknown as { copyLastMessage(): Promise<void> })["copyLastMessage"]();
			return true;
		}
		case "name": {
			const name = args || (await app.dialogs.input("Session name"));
			if (name !== undefined) {
				s.setSessionName(name);
				app.showStatus(name ? `Session: ${name}` : "Name cleared");
			}
			return true;
		}
		case "session":
		case "stats":
		case "status": {
			const st = s.getSessionStats();
			const lines = [
				`session   ${st.sessionId}`,
				`file      ${st.sessionFile ?? "(in-memory)"}`,
				`messages  ${st.totalMessages} (${st.userMessages} user / ${st.assistantMessages} assistant)`,
				`tools     ${st.toolCalls} calls`,
				`tokens    in ${st.tokens.input} · out ${st.tokens.output} · cache r/w ${st.tokens.cacheRead}/${st.tokens.cacheWrite}`,
				`cost      $${st.cost.toFixed(4)}`,
				st.contextUsage ? `context   ${st.contextUsage.tokens ?? "?"} / ${st.contextUsage.contextWindow}` : "",
			].filter(Boolean);
			app.transcript.container.addChild(new Text(lines.join("\n"), 1, 1));
			app.tui.requestRender();
			return true;
		}
		case "reload": {
			await s.reload();
			app.showStatus("Reloaded extensions & resources");
			return true;
		}
		case "trust": {
			const { ProjectTrustStore } = await import("@earendil-works/pi-coding-agent");
			const ok = await app.dialogs.confirm("Project trust", "Trust this project (loads .pi resources next run)?");
			if (ok) {
				new ProjectTrustStore(app.agentDir()).set(s.sessionManager.getCwd(), true);
				app.showStatus("Trusted — /reload to apply now");
			}
			return true;
		}
		case "clear": {
			app.editor.setText("");
			return true;
		}
		case "timeline":
		case "turns": {
			openTimeline(app);
			return true;
		}
		default:
			// Not a local command — let pi handle extension commands / templates
			return false;
	}
}

// ---------------------------------------------------------------------
// Selectors
// ---------------------------------------------------------------------

export async function openModelSelector(app: App) {
	const s = app.session;
	const scoped = s.scopedModels.map((sm) => ({ model: sm.model, thinkingLevel: sm.thinkingLevel }));
	const sel = new ModelSelectorComponent(
		app.tui,
		s.model,
		s.modelRuntime,
		scoped as never,
		(model) => {
			void s.setModel(model).then(() => app.showStatus(`Model: ${model.provider}/${model.id}`));
			app.tui.hideOverlay();
			app.tui.setFocus(app.editor);
		},
		() => {
			app.tui.hideOverlay();
			app.tui.setFocus(app.editor);
		},
		"",
		(model) => {
			void s.setModel(model, { persist: true }).then(() => app.showStatus(`Default model: ${model.provider}/${model.id}`));
			app.tui.hideOverlay();
			app.tui.setFocus(app.editor);
		},
	);
	app.dialogs.show(sel as never, { width: "90%", maxHeight: "80%" });
}

export async function openThinkingSelector(app: App) {
	const s = app.session;
	const sel = new ThinkingSelectorComponent(
		s.thinkingLevel,
		s.getAvailableThinkingLevels(),
		(level) => {
			s.setThinkingLevel(level);
			app.tui.hideOverlay();
			app.tui.setFocus(app.editor);
			app.showStatus(`Thinking: ${level}`);
		},
		() => {
			app.tui.hideOverlay();
			app.tui.setFocus(app.editor);
		},
	);
	app.dialogs.show(sel as never, { width: "50%", maxHeight: "60%" });
}

export async function openResume(app: App) {
	const cwd = s_cwd(app);
	const sel = new SessionSelectorComponent(
		(onProgress, signal) => SessionManager.list(cwd, undefined, onProgress, signal),
		(onProgress, signal) => SessionManager.listAll(undefined, onProgress, signal),
		(path) => {
			void app.runtime.switchSession(path);
			app.tui.hideOverlay();
			app.tui.setFocus(app.editor);
		},
		() => {
			app.tui.hideOverlay();
			app.tui.setFocus(app.editor);
		},
		() => {
			app.tui.hideOverlay();
			app.tui.setFocus(app.editor);
		},
		() => app.tui.requestRender(),
		undefined,
		app.session.sessionFile,
	);
	app.dialogs.show(sel as never, { width: "90%", maxHeight: "80%" });
}

export async function openFork(app: App) {
	const msgs = app.session.getUserMessagesForForking().map((m) => ({
		id: m.entryId,
		text: m.text,
	}));
	if (msgs.length === 0) {
		app.showStatus("No user messages to fork from", "warning");
		return;
	}
	const sel = new UserMessageSelectorComponent(
		msgs,
		(entryId) => {
			void app.runtime.fork(entryId).then((r) => {
				if (!r.cancelled && r.selectedText) app.editor.setText(r.selectedText);
				app.showStatus("Forked");
			});
			app.tui.hideOverlay();
			app.tui.setFocus(app.editor);
		},
		() => {
			app.tui.hideOverlay();
			app.tui.setFocus(app.editor);
		},
	);
	app.dialogs.show(sel as never, { width: "80%", maxHeight: "70%" });
}

export async function openTree(app: App) {
	const tree = app.session.sessionManager.getTree();
	const leafId = app.session.sessionManager.getLeafId();
	const sel = new TreeSelectorComponent(
		tree,
		leafId,
		app.tui.terminal.rows ?? 24,
		(entryId) => {
			void app.session.navigateTree(entryId).then((r) => {
				if (!r.cancelled) app.rebuild();
			});
			app.tui.hideOverlay();
			app.tui.setFocus(app.editor);
		},
		() => {
			app.tui.hideOverlay();
			app.tui.setFocus(app.editor);
		},
	);
	app.dialogs.show(sel as never, { width: "90%", maxHeight: "80%" });
}

function openTimeline(app: App) {
	const anchors = app.transcript.turnAnchors;
	if (anchors.length === 0) {
		app.showStatus("No turns yet", "warning");
		return;
	}
	const items = anchors.map((a, i) => ({ value: String(i), label: `#${i + 1} ${a.label}` }));
	class TimelineList extends Container implements Focusable {
		focused = true;
		private list = new SelectList(items, 14, app.tm().getSelectListTheme());
		private done() {
			app.tui.hideOverlay();
			app.tui.setFocus(app.editor);
		}
		constructor() {
			super();
			this.list.onSelect = (item: { value: string }) => {
				const anchor = anchors[Number(item.value)];
				this.done();
				app.scrollToComponent?.(anchor.component);
			};
			this.list.onCancel = () => this.done();
			this.addChild(this.list);
		}
		handleInput(d: string) {
			this.list.handleInput(d);
		}
	}
	app.dialogs.show(new TimelineList() as never, { width: "70%", maxHeight: "60%" });
}

function s_cwd(app: App): string {
	return app.session.sessionManager.getCwd();
}
