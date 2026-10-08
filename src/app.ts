/**
 * ButterApp — the fullscreen TUI orchestrator.
 * Owns the TuiAltScreen layout, the editor, transcript, status bar,
 * session event wiring, and the extension UI context.
 */

import {
	CustomEditor,
	keyHint,
	keyText,
	rawKeyHint,
	type AgentSession,
	type AgentSessionEvent,
	type AgentSessionRuntime,
	type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import {
	CombinedAutocompleteProvider,
	Container,
	ProcessTerminal,
	ScrollView,
	setKeybindings,
	Spacer,
	Text,
	TuiAltScreen,
	VStack,
	type Component,
} from "@earendil-works/pi-tui";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Dialogs, ToastBar } from "./dialogs.js";
import { ButterEditor } from "./boxed-editor.js";
import {
	deepImport,
	importFromCodingAgent,
	themeModule,
	type FooterDataProviderApi,
	type ThemeModule,
} from "./internals.js";
import { StatusBar } from "./statusbar.js";
import { Transcript } from "./transcript.js";
import type { ButterOptions } from "./options.js";
import { createRequire } from "node:module";

const BRAND = "🧈 butterpi";
const VERSION = (createRequire(import.meta.url)("../package.json") as { version?: string }).version ?? "?";
const DEFAULT_WORKING = "";

export class ButterApp {
	readonly tui: TuiAltScreen;
	dialogs!: Dialogs;
	transcript!: Transcript;
	statusBar!: StatusBar;
	toastBar!: ToastBar;
	editor!: CustomEditor;
	readonly runtime: AgentSessionRuntime;

	private tmModule!: ThemeModule;
	private renderers?: { withBuiltInRenderers: (n: string, d: any) => any };
	private keybindings: any;
	private _session: AgentSession;
	private unsubscribe?: () => void;
	private opts: ButterOptions;

	private transcriptScroll?: ScrollView;
	private pendingContainer = new Container();
	private statusContainer = new Container();
	private widgetAbove = new Container();
	private widgetBelow = new Container();
	private editorContainer = new Container();
	private headerContainer = new Container();

	private workingMessage = DEFAULT_WORKING;
	private hideThinking = false;
	private outputPad = 0;
	private toolExpanded = false;
	private footerDataProvider?: FooterDataProviderApi;

	private tpsWindow: { t: number; chars: number }[] = [];
	private disposed = false;

	constructor(runtime: AgentSessionRuntime, opts: ButterOptions) {
		this.runtime = runtime;
		this._session = runtime.session;
		this.opts = opts;
		this.tui = new TuiAltScreen(new ProcessTerminal(), true, undefined, {
			mouse: true,
			copyOnSelect: true,
			scrollToEndIndicator: () => " ↓ new ",
		});
	}

	get session(): AgentSession {
		return this._session;
	}
	tm(): ThemeModule {
		return this.tmModule;
	}
	agentDir(): string {
		return this.opts.agentDir ?? this.runtime.services.agentDir;
	}
	rebuild() {
		this.transcript.rebuildFromSession(this.renderers);
	}
	scrollToComponent(component: Component) {
		if (!this.transcriptScroll) return;
		const width = Math.max(20, this.tui.terminal.columns);
		let top = 0;
		for (const child of this.transcript.container.children) {
			if (child === component) break;
			top += child.render(width).length;
		}
		this.transcriptScroll.scrollTo(top);
		this.tui.requestRender();
	}

	async init(): Promise<void> {
		const tm = await themeModule();
		this.tmModule = tm;
		const theme = tm.theme;
		this.dialogs = new Dialogs(this.tui, tm);

		const settingsManager = this.runtime.services.settingsManager;
		tm.initTheme(this.opts.theme ?? settingsManager.getTheme?.(), false);

		const kbMod = await deepImport<{ KeybindingsManager: any }>("dist/core/keybindings.js");
		this.keybindings =
			kbMod.KeybindingsManager.create?.(this.agentDir()) ?? new kbMod.KeybindingsManager(this.agentDir());
		setKeybindings(this.keybindings);
		// Register on pi's nested pi-tui copy too — pi's components read the
		// singleton from their own module instance.
		try {
			const nested = await importFromCodingAgent<{ setKeybindings(k: unknown): void }>(
				"@earendil-works/pi-tui",
			);
			nested.setKeybindings(this.keybindings);
		} catch {}

		this.renderers = await deepImport("dist/core/tools/renderers/index.js");

		const footerMod = await deepImport<{ FooterDataProvider: new (cwd: string) => FooterDataProviderApi }>(
			"dist/core/footer-data-provider.js",
		);
		this.footerDataProvider = new footerMod.FooterDataProvider(this.session.sessionManager.getCwd());
		this.footerDataProvider.onBranchChange(() => {
			this.statusBar.state.gitBranch = this.footerDataProvider?.getGitBranch() ?? null;
			this.tui.requestRender();
		});

		this.transcript = new Transcript({
			tui: this.tui,
			themeModule: tm,
			getSession: () => this.session,
			requestRender: () => this.tui.requestRender(),
			getToolExpanded: () => this.toolExpanded,
			setToolExpanded: (v) => (this.toolExpanded = v),
			hideThinking: this.hideThinking,
			hiddenThinkingLabel: "⚓ Thinking",
			outputPad: this.outputPad,
		});

		this.toastBar = new ToastBar(theme, () => this.tui.requestRender());
		this.statusBar = new StatusBar(theme, () => this.session, () => this.tui.requestRender(), BRAND);
		this.statusBar.state.gitBranch = this.footerDataProvider.getGitBranch();
		this.statusBar.state.sessionName = this.session.sessionName;
		this.statusBar.startTicker();

		this.editor = new ButterEditor(
			this.tui,
			tm.getEditorTheme(),
			this.keybindings,
			{ embedWorkingStatus: false },
			theme,
			() => this.session.isStreaming || this.session.isCompacting,
		);
		this.editorContainer.addChild(this.editor);
		this.setupEditorActions();
		this.setupAutocomplete();

		this.transcriptScroll = new ScrollView(this.transcript.container, {
			follow: "end",
			primary: true,
			overscroll: "chain",
			scrollbar: "auto",
			scrollbarTrackStyle: (s) => theme.fg("scrollbarTrack", s),
			scrollbarThumbStyle: (s) => theme.fg("scrollbarThumb", s),
		});

		const dock = new VStack([
			{ component: this.pendingContainer, shrink: 1, minSize: 0 },
			{ component: this.statusContainer, shrink: 1, minSize: 0 },
			{ component: this.widgetAbove, shrink: 1, minSize: 0 },
			{ component: this.editorContainer, shrink: 1, minSize: 3 },
			{ component: this.widgetBelow, shrink: 1, minSize: 0 },
			{ component: this.toastBar, shrink: 1, minSize: 0 },
			{ component: this.statusBar, shrink: 1, minSize: 1 },
		]);
		const root = new VStack([
			{ component: this.transcriptScroll, basis: 0, grow: 1, shrink: 1, minSize: 1 },
			{ component: dock, basis: "auto", grow: 0, shrink: 1, minSize: 1 },
		]);
		this.tui.setLayoutRoot(root);
		this.tui.setShowHardwareCursor(true);

		this.addHeader();
		this.renderHistory();
		this.bindSession(this.session);
		this.runtime.setRebindSession?.(async (newSession: AgentSession) => {
			this.bindSession(newSession);
		});

		this.tui.setFocus(this.editor);
		this.tui.start();

		this.editor.onSubmit = (text) => void this.handleSubmit(text);
		this.editor.onEscape = () => this.handleEscape();
		this.editor.onCtrlD = () => void this.shutdown();

		process.on("SIGINT", () => this.handleCtrlC());
		process.on("SIGTERM", () => void this.shutdown());

		for (const d of this.runtime.diagnostics) {
			this.showStatus(`${d.type}: ${d.message}`, d.type === "error" ? "error" : "warning");
		}
		if (this.runtime.modelFallbackMessage) {
			this.showStatus(this.runtime.modelFallbackMessage, "warning");
		}
		if (this.opts.initialMessages.length > 0) {
			void this.promptText(this.opts.initialMessages.join(" "));
		}
	}

	private addHeader() {
		const theme = this.tm().theme;
		this.headerContainer.clear();
		const cwd = this.session.sessionManager.getCwd();
		const model = this.session.model;
		const title = theme.fg("accent", theme.bold("✦ butterpi")) + theme.fg("dim", ` v${VERSION}`);
		const sub = theme.fg(
			"dim",
			`${model ? `${model.provider}/${model.id}` : "no model"} · ${cwd}`,
		);
		const hints = [
			keyHint("app.interrupt", "interrupt"),
			rawKeyHint(`${keyText("app.clear")}/${keyText("app.exit")}`, "clear/exit"),
			rawKeyHint("/", "commands"),
			rawKeyHint("!", "bash"),
			rawKeyHint("@", "files"),
			keyHint("app.tools.expand", "expand tools"),
		].join(theme.fg("muted", " · "));
		const rule = theme.fg("dim", "─".repeat(Math.max(10, Math.min(this.tui.terminal.columns - 2, 120))));
		this.headerContainer.addChild(new Text(title, 2, 0));
		this.headerContainer.addChild(new Text(sub, 2, 0));
		this.headerContainer.addChild(new Text(hints, 2, 0));
		this.headerContainer.addChild(new Text("  " + rule, 0, 0));
		this.transcript.container.addChild(this.headerContainer);
	}

	private renderHistory() {
		const entries = this.session.sessionManager.buildContextEntries();
		this.transcript.renderSessionEntries(entries, this.renderers);
		for (const m of this.session.messages) {
			if (m.role === "user") {
				const content = (m as { content?: unknown }).content;
				const text =
					typeof content === "string"
						? content
						: Array.isArray(content)
							? (content as { type: string; text?: string }[]).filter((c) => c.type === "text").map((c) => c.text ?? "").join("")
							: "";
				if (text) this.editor.addToHistory(text);
			}
		}
	}

	private bindSession(session: AgentSession) {
		this.unsubscribe?.();
		this._session = session;
		this.transcript.clear();
		this.addHeader();
		this.renderHistory();
		this.unsubscribe = session.subscribe((e) => this.onSessionEvent(e));
		this.setupAutocomplete();
		this.statusBar.state.sessionName = session.sessionName;
		this.tui.requestRender();
	}

	// ------------------------------------------------------------------
	// Editor actions & input
	// ------------------------------------------------------------------

	private setupEditorActions() {
		const e = this.editor;
		e.onAction("app.clear", () => this.handleCtrlC());
		e.onAction("app.thinking.cycle", () => this.cycleThinking());
		e.onAction("app.model.cycleForward", () => void this.cycleModel("forward"));
		e.onAction("app.model.cycleBackward", () => void this.cycleModel("backward"));
		e.onAction("app.model.select", () => void import("./commands.js").then((m) => m.openModelSelector(this)));
		e.onAction("app.tools.expand", () => this.toggleToolExpanded());
		e.onAction("app.thinking.toggle", () => this.toggleThinking());
		e.onAction("app.session.tree", () => void import("./commands.js").then((m) => m.openTree(this)));
		e.onAction("app.session.fork", () => void import("./commands.js").then((m) => m.openFork(this)));
		e.onAction("app.session.resume", () => void import("./commands.js").then((m) => m.openResume(this)));
		e.onAction("app.session.new", () => void this.newSession());
		e.onAction("app.message.followUp", () => this.submitAs("steer"));
		e.onAction("app.editor.external", () => void this.openExternalEditor());
		e.onAction("app.thinking.save", () => {
			const level = this.session.thinkingLevel;
			try {
				this.runtime.services.settingsManager.setModelThinkingLevel?.(
					this.session.model?.provider ?? "",
					this.session.model?.id ?? "",
					level,
				);
				this.showStatus(`Saved thinking level: ${level}`);
			} catch {
				this.showStatus("Could not persist thinking level", "warning");
			}
		});
		e.onPasteImage = () => void this.handleClipboardPaste();
		e.onAction("app.message.dequeue", () => this.restoreQueuedToEditor());
		e.onAction("app.message.copy", () => void this.copyLastMessage());
	}

	private async handleSubmit(text: string) {
		const trimmed = text.trim();
		if (!trimmed) return;
		this.editor.addToHistory(trimmed);
		await this.promptText(trimmed);
	}

	async promptText(text: string, opts?: { deliverAs?: "steer" | "followUp" }) {
		if (text.startsWith("!")) {
			const exclude = text.startsWith("!!");
			const cmd = text.slice(exclude ? 2 : 1);
			if (!cmd.trim()) {
				this.showStatus("Usage: !<command>", "warning");
				return;
			}
			await this.runBash(cmd, exclude);
			return;
		}
		if (text.startsWith("/")) {
			const handled = await import("./commands.js").then((m) => m.handleSlashCommand(this, text));
			if (handled) return;
		}
		try {
			if (this.session.isStreaming) {
				await this.session.prompt(text, { streamingBehavior: opts?.deliverAs ?? "followUp" });
			} else {
				await this.session.prompt(text);
			}
		} catch (err) {
			this.showStatus(`Error: ${err instanceof Error ? err.message : String(err)}`, "error");
		}
	}

	private async handleClipboardPaste() {
		try {
			const img = await deepImport<{
				readClipboardImage(): Promise<{ bytes: Uint8Array; mimeType: string } | null>;
				extensionForImageMimeType(m: string): string | undefined;
			}>("dist/utils/clipboard-image.js");
			const cb = await deepImport<{ readClipboardText(): Promise<string> }>("dist/utils/clipboard.js");
			const image = await img.readClipboardImage();
			if (image) {
				const ext = img.extensionForImageMimeType(image.mimeType) ?? "png";
				const filePath = join(tmpdir(), `butterpi-clipboard-${crypto.randomUUID()}.${ext}`);
				writeFileSync(filePath, Buffer.from(image.bytes));
				this.editor.insertTextAtCursor?.(filePath);
				this.tui.requestRender();
				return;
			}
			const text = await cb.readClipboardText();
			if (text) {
				this.editor.insertTextAtCursor?.(text);
				this.tui.requestRender();
			}
		} catch {
			// Clipboard unavailable — ignore.
		}
	}

	private async openExternalEditor() {
		const command = process.env.VISUAL ?? process.env.EDITOR;
		if (!command) {
			this.showStatus("Set $EDITOR or $VISUAL first", "warning");
			return;
		}
		this.tui.stop({ preserveScreen: true });
		try {
			const { editInExternalEditor } = await deepImport<{
				editInExternalEditor(o: { content: string; command: string }): Promise<{ status: string; content?: string }>;
			}>("dist/modes/interactive/external-editor.js");
			const result = await editInExternalEditor({ content: this.editor.getText(), command });
			if (result.status === "complete" && result.content !== undefined) {
				this.editor.setText(result.content);
			}
		} catch (err) {
			this.showStatus(`Editor failed: ${err instanceof Error ? err.message : err}`, "error");
		} finally {
			this.tui.start();
		}
	}

	private submitAs(mode: "steer" | "followUp") {
		const text = this.editor.getText().trim();
		if (!text) return;
		this.editor.setText("");
		void this.promptText(text, { deliverAs: mode });
	}

	private async runBash(cmd: string, excludeFromContext: boolean) {
		const { BashExecutionComponent } = await import("@earendil-works/pi-coding-agent");
		const comp = new BashExecutionComponent(cmd, this.tui, excludeFromContext);
		this.transcript.container.addChild(comp);
		this.tui.requestRender();
		try {
			const result = await this.session.executeBash(
				cmd,
				(chunk) => {
					comp.appendOutput(chunk);
					this.tui.requestRender();
				},
				{ excludeFromContext },
			);
			comp.setComplete(result.exitCode, result.cancelled, undefined, undefined);
		} catch (err) {
			comp.setComplete(1, false, undefined, undefined);
			this.showStatus(`bash failed: ${err instanceof Error ? err.message : err}`, "error");
		}
		this.tui.requestRender();
	}

	private handleEscape() {
		if (this.tui.hasOverlay()) {
			this.tui.hideOverlay();
			this.tui.setFocus(this.editor);
			return;
		}
		if (this.session.isCompacting) {
			this.session.abortCompaction();
			return;
		}
		if (this.session.retryAttempt > 0) {
			this.session.abortRetry();
			return;
		}
		if (this.session.isBashRunning) {
			this.session.abortBash();
			return;
		}
		if (this.session.isStreaming) {
			void this.session.abort();
			return;
		}
		if (this.session.pendingMessageCount > 0) {
			const q = this.session.clearQueue();
			this.editor.setText([...q.steering, ...q.followUp].join("\n"));
		}
	}

	private handleCtrlC() {
		if (this.editor.getText().length > 0) {
			this.editor.setText("");
			return;
		}
		void this.shutdown();
	}

	private restoreQueuedToEditor() {
		const q = this.session.clearQueue();
		const restored = [...q.steering, ...q.followUp].join("\n");
		if (restored) {
			const current = this.editor.getText();
			this.editor.setText(restored + (current ? "\n" + current : ""));
		}
		this.tui.requestRender();
	}

	private async copyLastMessage() {
		const last = this.session.getLastAssistantText();
		if (!last) {
			this.showStatus("Nothing to copy", "warning");
			return;
		}
		try {
			const { copyToClipboard } = await import("@earendil-works/pi-coding-agent");
			await copyToClipboard(last);
			this.showStatus("Copied last message");
		} catch {
			this.showStatus("Clipboard unavailable", "warning");
		}
	}

	private toggleToolExpanded() {
		this.transcript.setToolExpandedAll(!this.toolExpanded);
		this.showStatus(this.toolExpanded ? "Tool output: expanded" : "Tool output: collapsed");
	}

	private toggleThinking() {
		this.hideThinking = !this.hideThinking;
		this.transcript.hideThinkingUpdate(this.hideThinking);
		this.transcript.rebuildFromSession(this.renderers);
		this.showStatus(this.hideThinking ? "Thinking hidden" : "Thinking visible");
	}

	private async cycleModel(direction: "forward" | "backward") {
		try {
			const result = await this.session.cycleModel(direction);
			if (result) {
				this.showStatus(`Model: ${result.model.provider}/${result.model.id}${result.thinkingLevel ? `:${result.thinkingLevel}` : ""}`);
			}
		} catch (err) {
			this.showStatus(`Model switch failed: ${err instanceof Error ? err.message : err}`, "error");
		}
	}

	private cycleThinking() {
		const next = this.session.cycleThinkingLevel();
		if (next) this.showStatus(`Thinking: ${next}`);
	}

	async newSession() {
		try {
			await this.runtime.newSession();
		} catch (err) {
			this.showStatus(`New session failed: ${err instanceof Error ? err.message : err}`, "error");
		}
	}

	// ------------------------------------------------------------------
	// Session event handling
	// ------------------------------------------------------------------

	private onSessionEvent(e: AgentSessionEvent) {
		this.trackTps(e);
		this.transcript.handleEvent(e, this.renderers);
		switch (e.type) {
			case "queue_update":
				this.renderPendingQueue(e.steering, e.followUp);
				this.statusBar.state.queueCount = e.steering.length + e.followUp.length;
				break;
			case "agent_settled":
				this.statusBar.state.tps = 0;
				this.tpsWindow = [];
				this.statusBar.state.workingMessage = DEFAULT_WORKING;
				break;
			case "auto_retry_start":
				this.statusBar.state.workingMessage = `retry ${e.attempt}/${e.maxAttempts} in ${Math.round(e.delayMs / 1000)}s`;
				break;
			case "auto_retry_end":
				this.statusBar.state.workingMessage = DEFAULT_WORKING;
				break;
			case "compaction_start":
				this.statusBar.state.workingMessage = "compacting";
				break;
			case "compaction_end":
				this.statusBar.state.workingMessage = DEFAULT_WORKING;
				if (!e.aborted && e.result) this.transcript.rebuildFromSession(this.renderers);
				break;
			case "session_info_changed":
				this.statusBar.state.sessionName = e.name;
				break;
			case "entry_appended": {
				const entry = (e as { entry?: { type?: string; customType?: string } }).entry;
				if (entry?.type === "custom" && entry.customType) {
					void this.addCustomEntry(entry);
				}
				break;
			}
		}
		this.tui.requestRender();
	}

	private async addCustomEntry(entry: unknown) {
		try {
			const renderer = this.session.extensionRunner?.getEntryRenderer?.(
				(entry as { customType: string }).customType,
			);
			if (!renderer) return;
			const mod = await deepImport<{ CustomEntryComponent: new (e: unknown, r: unknown) => Component & { setExpanded(v: boolean): void; hasContent(): boolean } }>(
				"dist/modes/interactive/components/custom-entry.js",
			);
			const comp = new mod.CustomEntryComponent(entry, renderer);
			comp.setExpanded(this.toolExpanded);
			if (comp.hasContent()) {
				this.transcript.container.addChild(comp);
				this.tui.requestRender();
			}
		} catch {}
	}

	private renderPendingQueue(steering: readonly string[], followUp: readonly string[]) {
		this.pendingContainer.clear();
		const all = [
			...steering.map((s) => `steer ▸ ${s.split("\n")[0]}`),
			...followUp.map((s) => `queue ▸ ${s.split("\n")[0]}`),
		];
		for (const line of all.slice(0, 4)) {
			this.pendingContainer.addChild(new Text(this.tm().theme.fg("dim", ` ${line.slice(0, 200)}`), 0, 0));
		}
		if (all.length > 4) {
			this.pendingContainer.addChild(new Text(this.tm().theme.fg("dim", ` +${all.length - 4} more`), 0, 0));
		}
		this.tui.requestRender();
	}

	private trackTps(e: AgentSessionEvent) {
		if (e.type === "message_update" && e.assistantMessageEvent.type === "text_delta") {
			const now = Date.now();
			this.tpsWindow.push({ t: now, chars: e.assistantMessageEvent.delta.length });
			while (this.tpsWindow.length > 0 && now - this.tpsWindow[0].t > 3000) this.tpsWindow.shift();
			const span = Math.max(1, now - this.tpsWindow[0].t);
			this.statusBar.state.tps = (this.tpsWindow.reduce((a, b) => a + b.chars, 0) / span) * (1000 / 4);
		}
	}

	// ------------------------------------------------------------------
	// Extension UI context
	// ------------------------------------------------------------------

	private createUIContext(): ExtensionUIContext {
		const tm = this.tm();
		const app = this;
		const ctx = {
			select: (title: string, options: string[]) => app.dialogs.select(title, options),
			confirm: (title: string, message: string) => app.dialogs.confirm(title, message),
			input: (title: string, placeholder?: string) => app.dialogs.input(title, placeholder),
			notify: (message: string, type?: "info" | "warning" | "error") => app.toastBar.push(message, type ?? "info"),
			onTerminalInput: (handler: (data: string) => void) =>
				this.tui.addInputListener((d) => {
					handler(d);
					return undefined;
				}),
			setStatus: (key: string, text: string | undefined) => {
				this.footerDataProvider?.setExtensionStatus(key, text);
				this.statusBar.state.extensionStatuses = this.footerDataProvider?.getExtensionStatuses() ?? new Map();
				this.tui.requestRender();
			},
			setWorkingMessage: (m?: string) => {
				this.statusBar.state.workingMessage = m ?? DEFAULT_WORKING;
			},
			setWorkingVisible: () => {},
			setWorkingIndicator: () => {},
			setHiddenThinkingLabel: () => {},
			setWidget: (key: string, content: unknown, options?: { placement?: string }) => {
				const target = options?.placement === "belowEditor" ? this.widgetBelow : this.widgetAbove;
				const existing = target.children.find((c) => (c as { __key?: string }).__key === key);
				if (existing) target.removeChild(existing);
				if (content === undefined || content === null) {
					this.tui.requestRender();
					return;
				}
				let comp: Component & { __key?: string };
				if (Array.isArray(content)) {
					const c = new Container();
					for (const line of content as string[]) c.addChild(new Text(line, 1, 0));
					comp = c as never;
				} else {
					comp = (content as (tui: unknown, theme: unknown) => Component)(this.tui, tm.theme) as never;
				}
				comp.__key = key;
				target.addChild(comp);
				this.tui.requestRender();
			},
			setFooter: () => {},
			setHeader: () => {},
			setTitle: (title: string) => {
				process.stdout.write(`\x1b]0;${title}\x07`);
			},
			custom: async (factory: (tui: unknown, theme: unknown, kb: unknown, done: (v: unknown) => void) => Component | Promise<Component>, options?: { overlay?: boolean; overlayOptions?: unknown; onHandle?: (h: unknown) => void }) => {
				let doneFn: (v: unknown) => void = () => {};
				const donePromise = new Promise<unknown>((r) => (doneFn = r));
				const comp = await factory(this.tui, tm.theme, this.keybindings, (v) => doneFn(v));
				if (options?.overlay) {
					const h = this.tui.showOverlay(comp, options.overlayOptions as never);
					h.focus();
					options.onHandle?.(h);
				} else {
					this.transcript.container.addChild(comp);
					this.tui.requestRender();
				}
				return donePromise;
			},
			pasteToEditor: (text: string) => this.editor.setText(this.editor.getText() + text),
			setEditorText: (text: string) => this.editor.setText(text),
			getEditorText: () => this.editor.getText(),
			editor: async (title: string, prefill?: string) => this.dialogs.input(title, prefill),
			addAutocompleteProvider: () => {},
			setEditorComponent: () => {},
			getEditorComponent: () => undefined,
			theme: tm.theme,
			getAllThemes: () => tm.getAvailableThemesWithPaths(),
			getTheme: (name: string) => tm.getThemeByName(name),
			setTheme: (t: string | { name?: string }) => {
				const name = typeof t === "string" ? t : t?.name ?? "dark";
				return tm.setTheme(name);
			},
			getToolsExpanded: () => this.toolExpanded,
			setToolsExpanded: (v: boolean) => {
				if (v !== this.toolExpanded) this.toggleToolExpanded();
			},
		};
		return ctx as unknown as ExtensionUIContext;
	}

	async bindExtensions() {
		await this.session.bindExtensions({
			uiContext: this.createUIContext(),
			mode: "tui",
			abortHandler: () => this.restoreQueuedToEditor(),
			commandContextActions: {
				waitForIdle: () => this.session.waitForIdle(),
				newSession: async (options) => {
					try {
						return await this.runtime.newSession(options);
					} catch (err) {
						this.showStatus(`newSession failed: ${err}`, "error");
						return { cancelled: true };
					}
				},
				fork: async (entryId, options) => {
					try {
						const r = await this.runtime.fork(entryId, options);
						if (!r.cancelled && r.selectedText) this.editor.setText(r.selectedText);
						return { cancelled: r.cancelled };
					} catch {
						return { cancelled: true };
					}
				},
				navigateTree: async (targetId, options) => {
					const r = await this.session.navigateTree(targetId, options);
					if (!r.cancelled) this.rebuild();
					return { cancelled: r.cancelled };
				},
				switchSession: async (sessionPath, options) => {
					try {
						const r = await this.runtime.switchSession(sessionPath, options as never);
						return { cancelled: r.cancelled };
					} catch (err) {
						this.showStatus(`Switch failed: ${err}`, "error");
						return { cancelled: true };
					}
				},
				reload: async () => {
					try {
						await this.session.reload();
						this.setupAutocomplete();
						this.showStatus("Reloaded");
					} catch (err) {
						this.showStatus(`Reload failed: ${err}`, "error");
					}
				},
			},
			onError: (err) => this.showStatus(`Extension error: ${err?.error ?? err}`, "error"),
		});
	}

	private setupAutocomplete() {
		const builtin = [
			{ name: "help", description: "Show help" },
			{ name: "model", description: "Select model", argumentHint: "<provider/model>" },
			{ name: "thinking", description: "Set thinking level", argumentHint: "<level>" },
			{ name: "theme", description: "Switch theme" },
			{ name: "resume", description: "Resume a session" },
			{ name: "new", description: "New session" },
			{ name: "fork", description: "Fork from a user message" },
			{ name: "tree", description: "Navigate session tree" },
			{ name: "compact", description: "Compact context", argumentHint: "[instructions]" },
			{ name: "export", description: "Export session", argumentHint: "[path]" },
			{ name: "copy", description: "Copy last reply" },
			{ name: "name", description: "Set session name", argumentHint: "<name>" },
			{ name: "session", description: "Session stats" },
			{ name: "reload", description: "Reload extensions" },
			{ name: "trust", description: "Trust this project" },
			{ name: "timeline", description: "Jump to a turn" },
			{ name: "clear", description: "Clear editor" },
			{ name: "quit", description: "Quit" },
		] as ({ name: string; description?: string; argumentHint?: string } & Record<string, unknown>)[];
		const modelCmd = builtin.find((c) => c.name === "model");
		if (modelCmd) {
			modelCmd.getArgumentCompletions = (prefix: string) => {
				const models = this.session.modelRuntime.getAvailableSnapshot?.() ?? [];
				return models
					.map((m: { provider: string; id: string }) => ({
						value: `${m.provider}/${m.id}`,
						label: m.id,
						description: m.provider,
					}))
					.filter((i: { value: string }) => !prefix || i.value.includes(prefix));
			};
		}
		const thinkCmd = builtin.find((c) => c.name === "thinking");
		if (thinkCmd) {
			thinkCmd.getArgumentCompletions = (prefix: string) =>
				this.session
					.getAvailableThinkingLevels()
					.filter((l) => l.startsWith(prefix))
					.map((l) => ({ value: l, label: l }));
		}
		const templateCommands = this.session.promptTemplates.map((t) => ({
			name: t.name,
			description: t.description,
			...(t.argumentHint ? { argumentHint: t.argumentHint } : {}),
		}));
		const extensionCommands =
			this.session.extensionRunner
				?.getRegisteredCommands?.()
				.map((c: { invocationName: string; description?: string; getArgumentCompletions?: unknown }) => ({
					name: c.invocationName,
					description: c.description,
					getArgumentCompletions: c.getArgumentCompletions,
				})) ?? [];
		const skills =
			(
				this.session as unknown as {
					resourceLoader?: { getSkills(): { skills: { name: string; description?: string }[] } };
				}
			).resourceLoader?.getSkills().skills ?? [];
		const skillCommands = skills.map((s) => ({ name: `skill:${s.name}`, description: s.description }));

		const provider = new CombinedAutocompleteProvider(
			[...builtin, ...templateCommands, ...extensionCommands, ...skillCommands] as never,
			this.session.sessionManager.getCwd(),
		);
		this.editor.setAutocompleteProvider(provider);
	}

	// ------------------------------------------------------------------
	// Lifecycle
	// ------------------------------------------------------------------

	showStatus(text: string, kind: "info" | "warning" | "error" = "info") {
		this.toastBar.push(text, kind);
	}

	async shutdown() {
		if (this.disposed) return;
		this.disposed = true;
		this.statusBar.stopTicker();
		this.footerDataProvider?.dispose();
		try {
			this.session.dispose();
		} catch {}
		try {
			this.tui.stop({ preserveScreen: false });
		} catch {}
		process.exit(0);
	}
}
