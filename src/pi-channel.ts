/**
 * PiChannel — the ChannelUi surface that the vendored dsh-TUI Chat screen
 * renders, backed by pi's AgentSession/AgentSessionRuntime.
 *
 * Semantics follow dsh-TUI's channel contract:
 * - `version` bumps on every mutation; screens re-render via `subscribe`.
 * - `rows` is the transcript projection of session events (never optimistic).
 * - `submit` routes `!`/`!!` to the local shell and everything else to
 *   `session.prompt()` (which dispatches pi extension commands / skills /
 *   prompt templates itself, preserving /cmd semantics).
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir, platform } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { execFile, execFileSync, spawnSync } from "node:child_process";
import type { AgentSession, AgentSessionRuntime, AgentSessionEvent, SessionEntry } from "@earendil-works/pi-coding-agent";
import { SessionManager, sessionEntryToContextMessages } from "@earendil-works/pi-coding-agent";
import type { TuiDialogStore } from "./vendor/dsh/dsh-adapter/dialogs.js";
import { codingAgentDistPath } from "./internals.js";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ImageContent, TextContent } from "@earendil-works/pi-ai";
import type {
	ChatRow,
	ToolRow,
	ToolCallView,
	ToolResultView,
	ToolFileDiff,
	TokenUsage,
	NotificationItem,
	ChannelGoal,
	TodoPanelItem,
	LoadedContext,
	PendingMessage,
	ChannelSceneMetadata,
	SubagentState,
	SubagentControl,
	BackgroundJobState,
	JobControl,
	StagedImageInput,
	StagedImageHandle,
	ComposerImageRef,
	ComposerSubmission,
	ExternalCommandOutcome,
	TranscriptImage,
	ResumeResult,
	EffortOption,
	PermissionPresetSnapshot,
	PresetOption,
	LlmModelInfo,
	LlmProviderInfo,
	SkillInfo,
	CredentialStatus,
	AgentViewRow,
	AgentViewDispatchResult,
	BackgroundResult,
	RawTrajEvent,
	ChannelSelection,
	CompactionStatus,
	AgentStatus,
	ChannelImageMediaType,
} from "./vendor/dsh/adapter/ports/channel-view.js";
import type {
	SpinnerMode,
	ToolBackground,
	ScrollGutterMode,
	PageMarginSetting,
	StatusBarConfig,
	SessionModeSpec,
	SplashFontSetting,
} from "./vendor/dsh/adapter/ports/channel-display.js";
import type {
	LocalCommand,
	CommandCompletion,
	BalanceResult,
	FileCandidate,
	RecapOutcome,
} from "./vendor/dsh/adapter/ports/channel-catalog.js";
import type {
	TuiRewindMode,
	SessionTreeData,
	TreeNode,
	TreeEntry,
	SessionSummary,
	PreviewEntry,
	TurnRange,
	SessionTreeMeta,
	SessionRewindFacts,
} from "./vendor/dsh/adapter/ports/channel-session.js";
import type {
	TuiWorkspaceTarget,
	TuiWorkspaceCommand,
	TuiWorkspaceCommandResult,
	TuiWorkspaceEntry,
} from "./vendor/dsh/adapter/ports/channel-workspace.js";
import type {
	ProviderSetupHost,
	OAuthProviderStatus,
	SettingsHost,
	TuiSettingsSection,
} from "./vendor/dsh/adapter/ports/channel-settings.js";
import type { ChannelUi } from "./vendor/dsh/adapter/channel/ui-policy.js";
import { LOCAL_COMMANDS, completeCommands } from "./vendor/dsh/commands.js";
import { DEFAULT_STATUS_BAR, applyPageMargin } from "./vendor/dsh/tuiDisplayPrefs.js";
import type { ButterOptions } from "./options.js";
import type { ButterRuntime } from "./runtime.js";

// ─── persisted display prefs ─────────────────────────────────────────

interface ButterPrefs {
	toolBackground?: ToolBackground;
	scrollGutter?: ScrollGutterMode;
	pageMargin?: PageMarginSetting;
	foldTerminalCommand?: boolean;
	promptSessionLabel?: boolean;
	expandEditor?: boolean;
	smoothStreaming?: boolean;
	diffLayout?: "auto" | "split" | "unified";
	thinkingFold?: "preview" | "full";
	statusBar?: Partial<StatusBarConfig>;
	whale?: boolean;
	whaleIdle?: boolean;
	whaleGirl?: boolean;
	minimal?: boolean;
	splashFont?: SplashFontSetting;
	activityFrames?: string;
	resumeTarget?: string;
}

/** One durable workspace registration (butterpi's own ledger). */
interface WorkspaceRecord {
	id: string;
	path: string;
	title: string;
}

interface StagedImage {
	data: Uint8Array;
	mediaType: ChannelImageMediaType;
	name?: string;
	path?: string;
	width?: number;
	height?: number;
}

const TOOL_BACKGROUND_SET = new Set(["none", "subtle", "strong"]);
const SCROLL_GUTTER_SET = new Set(["timeline", "scrollbar", "hidden"]);
const DIFF_LAYOUT_SET = new Set(["auto", "split", "unified"]);

function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return (content as TextContent[])
			.filter((c) => c && c.type === "text")
			.map((c) => c.text ?? "")
			.join("");
	}
	return "";
}

function previewText(text: string, max = 240): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length <= max ? flat : flat.slice(0, max - 1) + "…";
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

/** Best-effort PNG/JPEG/GIF/WebP dimension sniffing for staged images. */
function sniffImageSize(data: Uint8Array): { width?: number; height?: number } {
	try {
		// PNG: width/height big-endian at offset 16
		if (data.length > 24 && data[0] === 0x89 && data[1] === 0x50) {
			return {
				width: (data[16]! << 24) | (data[17]! << 16) | (data[18]! << 8) | data[19]!,
				height: (data[20]! << 24) | (data[21]! << 16) | (data[22]! << 8) | data[23]!,
			};
		}
		// GIF: width/height little-endian at offset 6
		if (data.length > 10 && data[0] === 0x47 && data[1] === 0x49) {
			return { width: data[6]! | (data[7]! << 8), height: data[8]! | (data[9]! << 8) };
		}
	} catch {
		// best effort only
	}
	return {};
}

export class PiChannel implements ChannelUi {
	private runtime: AgentSessionRuntime;
	private opts: ButterOptions;
	private prefsPath: string;
	private prefs: ButterPrefs;

	private listeners = new Set<() => void>();
	private _version = 0;
	private streamTimer: ReturnType<typeof setTimeout> | undefined;

	rowList: ChatRow[] = [];
	private rowSeq = 0;
	private toolRows = new Map<string, ChatRow>(); // toolCallId → row
	private noticeSeq = 0;
	private noticeItems: NotificationItem[] = [];
	private notifySeq = 0;

	private _session: AgentSession;
	private unsubscribe?: () => void;
	private bindingGeneration = 0;
	private rebuildTimer: ReturnType<typeof setTimeout> | undefined;

	// Trajectory event log: pi AgentSessionEvents translated into the
	// RawTrajEvent vocabulary the dsh trajectory fold consumes. Append-only
	// per session bind; extendTrajectory consumes the tail incrementally.
	private _traj: RawTrajEvent[] = [];
	private _trajFrozen: RawTrajEvent[] = [];
	private _trajTurn = 0;
	private _trajStep = 0;
	private _trajChunkSeen = new Set<number>();
	private _trajRetryId: string | undefined;
	private _trajRetry = 0;

	// assistant group projection state
	private groupStart = -1; // rowList index where the live assistant group begins
	private groupRowIds: string[] = []; // row kind per slot for id stability
	private groupStreaming = false;
	private groupOpenedAt = 0;
	private lastReasoningRowId = -1;

	// bash (user `!`) streaming row
	private bashRowId = -1;
	private bashOutputId = -1;

	private _working = false;
	private _cancelPending = false;
	private _turnStart = 0;
	private _responseChars = 0;
	private _activeToolCount = 0;
	private _pending: PendingMessage[] = [];
	private _compaction: CompactionStatus | undefined;
	private _sessionTitle = "";
	private _sessionColor = "";
	private _tokens: TokenUsage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		peak: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		idle: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
	private _lastUsage: { input: number; output: number; cacheRead: number; cacheWrite: number } | undefined;
	private _tpsSamples: { tps: number; at: number }[] = [];
	private tpsWindow: { t: number; chars: number }[] = [];
	private _lastUserText = "";
	private _gitBranch: string | undefined;
	private gitTimer: ReturnType<typeof setInterval> | undefined;
	private gitRefreshing = false;

	private stagedImages = new Map<string, { image: StagedImage; transcript: TranscriptImage }>();
	private stageSeq = 0;
	private stageGeneration = 0;

	private sessionPathCache = new Map<string, string>(); // sessionId → file path
	private history: string[] = [];
	private workspacesPath: string;
	private workspaces: WorkspaceRecord[] | undefined;
	private extensionBinder?: (session: AgentSession) => Promise<unknown> | unknown;
	private dialogs?: TuiDialogStore;

	/** chat-app installs the extension binding after construction; rebind on every session swap. */
	setExtensionBinder(fn: (session: AgentSession) => Promise<unknown> | unknown): void {
		this.extensionBinder = fn;
	}

	/** chat-app installs the dialog queue used by pi command flows (/login, /import…). */
	setDialogStore(store: TuiDialogStore): void {
		this.dialogs = store;
	}

	constructor(rt: ButterRuntime, opts: ButterOptions) {
		this.runtime = rt.runtime;
		this.opts = opts;
		this._session = rt.runtime.session;
		this.prefsPath = join(this.agentDir(), "butterpi-ui.json");
		this.prefs = this.readPrefs();
		this.workspacesPath = join(this.agentDir(), "butterpi-workspaces.json");
		this.loadHistory();
		// The launch directory is always a workspace, so the home screen has a
		// row even on a first run.
		this.ensureWorkspace(this._session.sessionManager.getCwd());
		this.bindSession(this._session, { replay: true });
		this.runtime.setRebindSession?.(async (session: AgentSession) => {
			this.bindSession(session, { replay: true });
		});
		this.refreshGitBranch();
		this.gitTimer = setInterval(() => this.refreshGitBranch(), 5000);
		this.gitTimer.unref?.();
	}

	agentDir(): string {
		return this.opts.agentDir ?? this.runtime.services.agentDir;
	}

	// ─── reactivity ────────────────────────────────────────────────────

	get version(): number {
		return this._version;
	}

	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	};

	private emit(): void {
		this._version++;
		for (const l of [...this.listeners]) l();
	}

	/** Coalesced emit for streaming deltas (~60fps upper bound). */
	private emitStream(): void {
		if (this.streamTimer) return;
		this.streamTimer = setTimeout(() => {
			this.streamTimer = undefined;
			this.emit();
		}, 16);
	}

	get rows(): readonly ChatRow[] {
		return this.rowList;
	}

	get status(): AgentStatus | "starting" | "disposed" {
		return this._working ? "running" : "idle";
	}

	get sessionTitle(): string {
		return this._sessionTitle;
	}

	get sessionColor(): string {
		return this._sessionColor;
	}

	get agentId(): string {
		return this._session.sessionId;
	}

	get sessionId(): string {
		return this._session.sessionId;
	}

	get agentBindingGeneration(): number {
		return this.bindingGeneration;
	}

	get autoRecapOnOpen(): boolean {
		return false;
	}

	get model(): string {
		return this._session.model?.id ?? "";
	}

	get provider(): string {
		return this._session.model?.provider ?? "";
	}

	get configuredProvider(): string | undefined {
		return this.opts.provider;
	}

	get configuredModel(): string | undefined {
		return this.opts.model;
	}

	get configuredPreset(): string | undefined {
		return undefined;
	}

	get configuredActivityFrames(): string | undefined {
		return undefined;
	}

	get configuredLang(): string | undefined {
		return undefined;
	}

	get tokens(): TokenUsage {
		return this._tokens;
	}

	get cwd(): string {
		return this._session.sessionManager.getCwd();
	}

	get displayCwd(): string {
		return this.cwd;
	}

	get gitBranch(): string | undefined {
		return this._gitBranch;
	}

	get working(): boolean {
		return this._working;
	}

	get compaction(): CompactionStatus | undefined {
		return this._compaction;
	}

	get cancelPending(): boolean {
		return this._cancelPending;
	}

	get spinnerMode(): SpinnerMode {
		if (this._activeToolCount > 0) return "tool-use";
		if (this._responseChars > 0) return "responding";
		return "thinking";
	}

	get responseChars(): number {
		return this._responseChars;
	}

	get activeToolCount(): number {
		return this._activeToolCount;
	}

	get turnStart(): number {
		return this._turnStart;
	}

	get lastUserText(): string {
		return this._lastUserText;
	}

	// ChannelUi field:
	get notifications(): readonly NotificationItem[] {
		return this.noticeItems;
	}

	get contextWindow(): number | undefined {
		return this._session.getContextUsage?.()?.contextWindow ?? (this._session.model as { contextWindow?: number } | undefined)?.contextWindow;
	}

	get reasoningEffort(): string | undefined {
		return this._session.thinkingLevel;
	}

	get effortLevels(): readonly string[] | undefined {
		try {
			return this._session.getAvailableThinkingLevels();
		} catch {
			return undefined;
		}
	}

	get lastUsage(): { input: number; output: number; cacheRead: number; cacheWrite: number } | undefined {
		return this._lastUsage;
	}

	get tps(): number | undefined {
		return this._tpsSamples.at(-1)?.tps;
	}

	get tpsSamples(): readonly { tps: number; at: number }[] {
		return this._tpsSamples;
	}

	get activityFrames(): string | undefined {
		return this.prefs.activityFrames;
	}

	get diffLayout(): "auto" | "split" | "unified" {
		return this.prefs.diffLayout ?? "auto";
	}

	get thinkingFold(): "preview" | "full" {
		return this.prefs.thinkingFold ?? "preview";
	}

	get toolBackground(): ToolBackground {
		return this.prefs.toolBackground ?? "none";
	}

	get scrollGutter(): ScrollGutterMode {
		return this.prefs.scrollGutter ?? "timeline";
	}

	get pageMargin(): PageMarginSetting {
		return this.prefs.pageMargin ?? "normal";
	}

	get foldTerminalCommand(): boolean {
		return this.prefs.foldTerminalCommand ?? false;
	}

	get promptSessionLabel(): boolean {
		return this.prefs.promptSessionLabel ?? false;
	}

	get expandEditor(): boolean {
		return this.prefs.expandEditor ?? true;
	}

	get smoothStreaming(): boolean {
		return this.prefs.smoothStreaming ?? true;
	}

	get statusBar(): Readonly<StatusBarConfig> {
		return { ...DEFAULT_STATUS_BAR, ...(this.prefs.statusBar ?? {}) };
	}

	get whale(): boolean {
		return this.prefs.whale ?? true;
	}

	get whaleIdle(): boolean {
		return this.prefs.whaleIdle ?? true;
	}

	get whaleGirl(): boolean {
		return this.prefs.whaleGirl ?? false;
	}

	get minimal(): boolean {
		return this.prefs.minimal ?? false;
	}

	get splashFont(): SplashFontSetting {
		return this.prefs.splashFont ?? "daily";
	}

	get activityEnabled(): boolean {
		return false;
	}

	get contextBarEnabled(): boolean {
		return this.statusBar.contextBar;
	}

	get goal(): ChannelGoal | undefined {
		return undefined;
	}

	get todos(): readonly TodoPanelItem[] {
		return [];
	}

	get loadedContext(): LoadedContext | undefined {
		const loader = this._session.resourceLoader;
		const skills = loader?.getSkills?.().skills ?? [];
		const tools = this._session.getAllTools?.() ?? [];
		const agentsFiles = loader?.getAgentsFiles?.().agentsFiles ?? [];
		return {
			sections: [],
			contexts: [],
			files: agentsFiles.map((f: { path: string }) => ({ displayPath: f.path })),
			skills: skills.map((s: { name: string; description?: string }) => ({ name: s.name, description: s.description ?? "" })),
			tools: (tools as { name?: string; description?: string }[]).map((t) => ({ name: t.name ?? "", description: t.description ?? "" })),
		};
	}

	get pending(): readonly PendingMessage[] {
		return this._pending;
	}

	get commandList(): readonly LocalCommand[] {
		const extras: LocalCommand[] = [];
		const seen = new Set(LOCAL_COMMANDS.map((c) => c.name));
		const push = (name: string, description: string, extra?: Partial<LocalCommand>) => {
			if (seen.has(name)) return;
			seen.add(name);
			extras.push({ name, description, ...extra });
		};
		try {
			for (const c of this._session.extensionRunner?.getRegisteredCommands?.() ?? []) {
				push(c.invocationName, c.description ?? "Extension command", { external: true });
			}
		} catch {}
		try {
			for (const t of this._session.promptTemplates ?? []) {
				push(t.name, t.description ?? "Prompt template", { external: true });
			}
		} catch {}
		try {
			const skills = this._session.resourceLoader?.getSkills?.().skills ?? [];
			for (const s of skills) push(s.name, s.description ?? "Skill", { skill: true });
		} catch {}
		// pi built-ins implemented in runExternalCommandOutcome (the dsh set
		// above only covers part of pi's BUILTIN_SLASH_COMMANDS).
		push("name", "Rename this session (alias of /rename)", { external: true });
		push("copy", "Copy last agent message to clipboard", { external: true });
		push("session", "Show session info and stats", { external: true });
		push("stats", "Show session statistics", { external: true });
		push("trust", "Trust this project's .pi resources", { external: true });
		push("clone", "Duplicate the current session at the current position", { external: true });
		push("import", "Import and resume a session from a JSONL file", { external: true });
		push("export", "Export session (HTML default, or specify path: .html/.jsonl)", { external: true });
		push("share", "Share session as a secret GitHub gist", { external: true });
		push("bug", "Report a bug (writes a report bundle)", { external: true });
		push("changelog", "Show changelog entries", { external: true });
		push("hotkeys", "Show all keyboard shortcuts");
		push("scoped-models", "Enable/disable models for Ctrl+P cycling", { external: true });
		push("settings", "Open settings menu", { external: true });
		push("login", "Configure provider authentication", { external: true });
		push("logout", "Remove provider authentication", { external: true });
		push("reload", "Reload keybindings, extensions, skills, prompts, themes, and context files", { external: true });
		push("theme-pi", "Switch pi theme (vendored /theme serves dsh themes)", { external: true });
		return [...LOCAL_COMMANDS, ...extras];
	}

	get selection(): ChannelSelection | undefined {
		return undefined;
	}

	get pluginScene(): ChannelSceneMetadata | undefined {
		return undefined;
	}

	get contextSegments() {
		const usage = this._session.getContextUsage?.();
		const used = usage?.tokens ?? this._lastUsage?.input ?? 0;
		return { system: 0, prompt: used, assistant: 0, thinking: 0, tools: 0 };
	}

	get subagents(): readonly SubagentState[] {
		return [];
	}

	get subagentControl(): SubagentControl {
		return { interrupt: () => false };
	}

	get backgroundJobs(): readonly BackgroundJobState[] {
		return [];
	}

	get jobControl(): JobControl {
		return { kill: () => false };
	}

	get mode(): SessionModeSpec {
		return { id: "default" };
	}

	get modeIndex(): number {
		return 0;
	}

	get agentPreset(): string | undefined {
		return undefined;
	}

	// ─── composer images ───────────────────────────────────────────────

	stagedImageGeneration(): number {
		return this.stageGeneration;
	}

	async stageImage(input: StagedImageInput): Promise<string> {
		const handle = await this.stageComposerImage(input, this.stageGeneration);
		const idx = [...this.stagedImages.keys()].indexOf(handle.stageId) + 1;
		return `[Image #${idx}]`;
	}

	async stageComposerImage(input: StagedImageInput, generation: number): Promise<StagedImageHandle> {
		if (generation !== this.stageGeneration) {
			throw new Error("stale composer generation");
		}
		const stageId = `img-${++this.stageSeq}`;
		const size = sniffImageSize(input.data);
		const image: StagedImage = { data: input.data, mediaType: input.mediaType, name: input.name, path: input.path, ...size };
		const transcript: TranscriptImage = {
			id: stageId,
			width: size.width ?? 0,
			height: size.height ?? 0,
			name: input.name,
			mediaType: input.mediaType,
			bytes: input.data.byteLength,
			path: input.path,
			read: async () => input.data,
		};
		this.stagedImages.set(stageId, { image, transcript });
		return { stageId };
	}

	hasStagedImage(stageId: string): boolean {
		return this.stagedImages.has(stageId);
	}

	discardStagedImage(stageId: string): void {
		this.stagedImages.delete(stageId);
	}

	stagedImage(stageId: string): TranscriptImage | undefined {
		return this.stagedImages.get(stageId)?.transcript;
	}

	stagedImageLimits() {
		return { maxImageBytes: 8 * 1024 * 1024, maxImagesPerMessage: 8, maxImageDimension: 8192, maxImagePixels: 40_000_000 };
	}

	private imagesFromRefs(refs: readonly ComposerImageRef[] | undefined): ImageContent[] {
		const out: ImageContent[] = [];
		for (const ref of refs ?? []) {
			const staged = this.stagedImages.get(ref.stageId)?.image;
			if (!staged) continue;
			out.push({ type: "image", data: Buffer.from(staged.data).toString("base64"), mimeType: staged.mediaType });
		}
		return out;
	}

	// ─── input actions ─────────────────────────────────────────────────

	submit(text: string, images?: readonly ComposerImageRef[]): void {
		const trimmed = text.trim();
		if (!trimmed) return;
		this.rememberHistory(trimmed);
		if (trimmed.startsWith("!!")) {
			void this.runLocalCommand(trimmed.slice(2).trim(), true);
			return;
		}
		if (trimmed.startsWith("!")) {
			void this.runLocalCommand(trimmed.slice(1).trim(), false);
			return;
		}
		this._lastUserText = trimmed;
		if (trimmed.startsWith("/")) {
			const spaceIdx = trimmed.indexOf(" ");
			const name = spaceIdx === -1 ? trimmed.slice(1) : trimmed.slice(1, spaceIdx);
			const args = spaceIdx === -1 ? undefined : trimmed.slice(spaceIdx + 1);
			this._trajPush("command/run", Date.now(), { name, args });
		}
		void this.session.prompt(trimmed, {
			images: this.imagesFromRefs(images),
			...(this._session.isStreaming ? { streamingBehavior: "followUp" as const } : {}),
		}).catch((err) => this.notify(`Error: ${err instanceof Error ? err.message : String(err)}`, { color: "error" }));
	}

	steer(text: string, images?: readonly ComposerImageRef[]): void {
		const trimmed = text.trim();
		if (!trimmed) return;
		this.rememberHistory(trimmed);
		this._lastUserText = trimmed;
		const opts = this._session.isStreaming ? { streamingBehavior: "steer" as const, images: this.imagesFromRefs(images) } : { images: this.imagesFromRefs(images) };
		void this.session.prompt(trimmed, opts).catch((err) => this.notify(`Error: ${err instanceof Error ? err.message : String(err)}`, { color: "error" }));
	}

	removePending(id: string): boolean {
		const idx = this._pending.findIndex((p) => p.id === id);
		if (idx === -1) return false;
		const steering = [...this._session.getSteeringMessages()];
		const followUp = [...this._session.getFollowUpMessages()];
		const combined: { text: string; placement: "steer" | "followup" }[] = [
			...steering.map((t) => ({ text: t, placement: "steer" as const })),
			...followUp.map((t) => ({ text: t, placement: "followup" as const })),
		];
		if (idx >= combined.length) return false;
		combined.splice(idx, 1);
		this._session.clearQueue();
		for (const item of combined) {
			void this.session.prompt(item.text, {
				...(this._session.isStreaming ? { streamingBehavior: item.placement === "steer" ? ("steer" as const) : ("followUp" as const) } : {}),
			}).catch(() => {});
		}
		return true;
	}

	cancel(): void {
		if (this._cancelPending) return;
		if (this._session.isCompacting) {
			this._session.abortCompaction();
			return;
		}
		if (this._session.retryAttempt > 0) {
			this._session.abortRetry();
			return;
		}
		if (this._session.isBashRunning) {
			this._session.abortBash();
			return;
		}
		this._cancelPending = true;
		void this.session.abort().finally(() => {
			this._cancelPending = false;
			this.emit();
		});
		this.emit();
	}

	interruptAndDeliver(inputs: readonly (string | ComposerSubmission)[]): number {
		const queued = inputs
			.map((input) =>
				typeof input === "string"
					? { text: input.trim(), images: [] as readonly ComposerImageRef[] }
					: { text: input.text.trim(), images: input.images ?? [] },
			)
			.filter((i) => i.text !== "");
		if (queued.length === 0) return 0;
		void this.session
			.abort()
			.catch(() => {})
			.then(() => {
				for (const entry of queued) {
					this.submit(entry.text, entry.images);
				}
			});
		return queued.length;
	}

	// ─── sessions ──────────────────────────────────────────────────────

	private entryIdForRow(row: ChatRow): string | undefined {
		if (row.kind !== "user") return undefined;
		const userRowIndex = this.rowList.filter((r) => r.kind === "user" && r.id <= row.id).length - 1;
		if (userRowIndex < 0) return undefined;
		const forkable = this._session.getUserMessagesForForking();
		return forkable[userRowIndex]?.entryId;
	}

	async rewindTo(row: ChatRow, _mode?: string | null): Promise<string | null> {
		const entryId = this.entryIdForRow(row);
		if (!entryId) {
			this.notify("Cannot rewind to that point", { color: "warning" });
			return null;
		}
		try {
			const result = await this.runtime.fork(entryId, { position: "before" });
			if (result.cancelled) return null;
			return result.selectedText ?? row.text;
		} catch (err) {
			this.notify(`Rewind failed: ${err instanceof Error ? err.message : String(err)}`, { color: "error" });
			return null;
		}
	}

	async promptRewind(_row: ChatRow): Promise<{ modes: readonly TuiRewindMode[] } | "cancel" | null> {
		return null;
	}

	async buildSessionTree(): Promise<SessionTreeData | null> {
		try {
			const tree = this.session.sessionManager.getTree();
			const sessions = new Map<string, SessionTreeMeta>();
			const rewindFacts = new Map<string, SessionRewindFacts>();
			const activePath = new Set<string>();
			const sessionId = this.sessionId;
			const turns: TurnRange[] = [];
			let seqCounter = 0;
			const convert = (node: { entry: SessionEntry; children: unknown[]; label?: string }, branchHead: boolean): TreeNode => {
				const entry = node.entry;
				const seq = seqCounter++;
				const kind: TreeEntry["kind"] =
					entry.type === "message"
						? (((entry as { message?: { role?: string } }).message?.role === "user"
								? "user"
								: (entry as { message?: { role?: string } }).message?.role === "assistant"
									? "assistant"
									: "notice") as TreeEntry["kind"])
						: entry.type === "compaction"
							? "compact"
							: "notice";
				const text =
					entry.type === "message"
						? previewText(contentText((entry as { message?: { content?: unknown } }).message?.content), 80)
						: entry.type === "compaction"
							? previewText((entry as { summary?: string }).summary ?? "compaction", 80)
							: entry.type;
				const treeEntry: TreeEntry = {
					sessionId,
					seq,
					kind,
					text,
					searchText: text,
					time: Date.parse(entry.timestamp ?? "") || Date.now(),
					label: node.label,
				};
				const converted: TreeNode = {
					id: `${sessionId}:${seq}`,
					entry: treeEntry,
					sessionId,
					branchHead,
					children: (node.children as { entry: SessionEntry; children: unknown[]; label?: string }[]).map((c) => convert(c, false)),
				};
				activePath.add(converted.id);
				return converted;
			};
			const roots = (tree as { entry: SessionEntry; children: unknown[]; label?: string }[]).map((n, i) => convert(n, i === 0));
			sessions.set(sessionId, { title: this._sessionTitle || undefined, createdAt: Date.now(), live: true, unreadable: false, unloaded: false });
			rewindFacts.set(sessionId, { turns, ownEntries: seqCounter, tailComplete: true });
			return { roots, activePath, activeLeafId: roots.at(-1)?.id ?? null, sessions, rewindFacts, truncated: false, sessionCount: 1 };
		} catch {
			this.notify("Session tree unavailable for this backend", { color: "warning" });
			return null;
		}
	}

	async rewindToNode(sessionId: string, seq: number, _mode?: "rewind" | "fork"): Promise<string | null> {
		if (sessionId !== this.sessionId) {
			this.notify("Cross-session adopt is not supported by the pi backend", { color: "warning" });
			return null;
		}
		try {
			const flat: string[] = [];
			const walk = (nodes: { entry: SessionEntry; children: unknown[] }[]) => {
				for (const n of nodes) {
					flat.push(n.entry.id);
					walk(n.children as { entry: SessionEntry; children: unknown[] }[]);
				}
			};
			walk(this.session.sessionManager.getTree() as { entry: SessionEntry; children: unknown[] }[]);
			const entryId = flat[seq];
			if (!entryId) return null;
			const r = await this.session.navigateTree(entryId);
			if (r.cancelled) return null;
			return r.editorText ?? null;
		} catch (err) {
			this.notify(`Tree navigation failed: ${err instanceof Error ? err.message : String(err)}`, { color: "error" });
			return null;
		}
	}

	async forkSession(): Promise<boolean> {
		try {
			const leaf = this._session.sessionManager.getLeafId();
			if (!leaf) {
				this.notify("Nothing to fork yet", { color: "warning" });
				return false;
			}
			const r = await this.runtime.fork(leaf, { position: "at" });
			return !r.cancelled;
		} catch (err) {
			this.notify(`Fork failed: ${err instanceof Error ? err.message : String(err)}`, { color: "error" });
			return false;
		}
	}

	async resumeTo(sessionId: string): Promise<ResumeResult> {
		const path = await this.resolveSessionPath(sessionId);
		if (!path) return { ok: false, reason: "unavailable" };
		try {
			return await this.switchInto(path);
		} catch (err) {
			// The session's recorded cwd is gone (the project was moved, renamed
			// or deleted, or the session came from another machine). pi refuses
			// to open it without an override, and pi's own fallback is to
			// continue in the current directory. Do that instead of failing:
			// the resume screen owns the whole terminal, so an interactive
			// "pick a directory" dialog would never be rendered and the resume
			// would silently hang.
			if (err instanceof Error && err.name === "MissingSessionCwdError") {
				const missing = (err as { issue?: { sessionCwd?: string } }).issue?.sessionCwd ?? "the recorded directory";
				try {
					const result = await this.switchInto(path, this.cwd);
					if (result.ok) {
						this.notify(`原目录不存在，已在当前目录打开该会话：\n${missing}`, { color: "warning", timeoutMs: 8000 });
					}
					return result;
				} catch (err2) {
					return { ok: false, reason: "failed", error: err2 instanceof Error ? err2.message : String(err2) };
				}
			}
			return { ok: false, reason: "failed", error: err instanceof Error ? err.message : String(err) };
		}
	}

	/** Switch into `path`, translating pi's `{ cancelled }` into a result. */
	private async switchInto(path: string, cwdOverride?: string): Promise<ResumeResult> {
		const result = await this.runtime.switchSession(path, cwdOverride === undefined ? undefined : { cwdOverride });
		if (result.cancelled) return { ok: false, reason: "cancelled" };
		return { ok: true };
	}

	async newSession(): Promise<boolean> {
		try {
			const r = await this.runtime.newSession();
			return !r.cancelled;
		} catch (err) {
			this.notify(`New session failed: ${err instanceof Error ? err.message : String(err)}`, { color: "error" });
			return false;
		}
	}

	// ─── workspaces ───────────────────────────────

	// pi's runtime is cwd-bound: `newSession()` always reuses the current cwd.
	// A workspace switch therefore creates a fresh session in the target
	// directory and re-seats the runtime on it via
	// `switchSession(path, { cwdOverride })`. The ledger persists under
	// <agentDir>/butterpi-workspaces.json.
	async listWorkspaces(): Promise<readonly TuiWorkspaceTarget[]> {
		const records = this.loadWorkspaces();
		const targets = records.map((w) => this.workspaceTarget(w.path));
		if (!records.some((w) => this.workspaceKey(w.path) === this.workspaceKey(this.cwd))) {
			targets.unshift(this.workspaceTarget(this.cwd));
		}
		return targets;
	}

	async listWorkspaceRegistry(): Promise<readonly TuiWorkspaceEntry[]> {
		if (!this.findWorkspace(this.cwd)) this.ensureWorkspace(this.cwd);
		const counts = new Map<string, number>();
		try {
			const infos = await SessionManager.listAll();
			for (const info of infos) {
				const cwd = (info as { cwd?: string }).cwd;
				if (!cwd) continue;
				const key = this.workspaceKey(cwd);
				counts.set(key, (counts.get(key) ?? 0) + 1);
			}
		} catch {
			// An unreadable session store still yields the ledger rows.
		}
		return this.loadWorkspaces().map((w) => ({
			id: w.id,
			path: w.path,
			title: w.title,
			present: existsSync(w.path),
			sessionCount: counts.get(this.workspaceKey(w.path)) ?? 0,
		}));
	}

	async removeWorkspace(path: string): Promise<boolean> {
		const key = this.workspaceKey(path);
		const list = this.loadWorkspaces();
		const index = list.findIndex((w) => this.workspaceKey(w.path) === key);
		if (index === -1) return false;
		list.splice(index, 1);
		this.saveWorkspaces();
		this.emit();
		return true;
	}

	async renameWorkspaceAt(path: string, title: string): Promise<boolean> {
		const record = this.findWorkspace(path);
		const next = title.trim();
		if (record === undefined || next === "") return false;
		// findWorkspace returns the record by reference, so mutating it keeps
		// the in-memory ledger and the persisted file in sync.
		record.title = next;
		this.saveWorkspaces();
		this.emit();
		return true;
	}

	async resolveWorkspace(reference: string): Promise<TuiWorkspaceTarget | undefined> {
		const trimmed = reference.trim();
		if (!trimmed) return undefined;
		let path = trimmed;
		if (path.startsWith("file://")) {
			try {
				path = fileURLToPath(path);
			} catch {
				return undefined;
			}
		} else if (path === "~") {
			path = homedir();
		} else if (path.startsWith("~/") || path.startsWith("~\\")) {
			path = join(homedir(), path.slice(2));
		}
		const abs = isAbsolute(path) ? resolve(path) : resolve(this.cwd, path);
		try {
			if (!statSync(abs).isDirectory()) return undefined;
		} catch {
			return undefined;
		}
		return this.workspaceTarget(abs);
	}

	async switchWorkspace(target: TuiWorkspaceTarget): Promise<boolean> {
		const nextCwd = target.cwd ? resolve(target.cwd) : "";
		if (!nextCwd || !existsSync(nextCwd)) {
			this.notify(`Workspace not found: ${target.cwd || "(empty)"}`, { color: "error" });
			return false;
		}
		try {
			if (this.workspaceKey(nextCwd) === this.workspaceKey(this.cwd)) {
				const result = await this.runtime.newSession();
				if (result.cancelled) return false;
			} else {
				const created = SessionManager.create(nextCwd, this.opts.sessionDir);
				const file = created.getSessionFile();
				if (!file) {
					this.notify("Could not create a session for this workspace", { color: "error" });
					return false;
				}
				const result = await this.runtime.switchSession(file, { cwdOverride: nextCwd });
				if (result.cancelled) return false;
			}
			this.ensureWorkspace(nextCwd);
			this.notify(`Workspace: ${basename(nextCwd) || nextCwd}`, { timeoutMs: 2000 });
			this.emit();
			return true;
		} catch (err) {
			this.notify(`Workspace switch failed: ${err instanceof Error ? err.message : String(err)}`, { color: "error" });
			return false;
		}
	}

	async renameWorkspace(title: string): Promise<boolean> {
		return this.renameWorkspaceAt(this.cwd, title);
	}

	workspaceCommands(): readonly Pick<TuiWorkspaceCommand, "name" | "aliases" | "description">[] {
		return [];
	}

	async runWorkspaceCommand(_name: string, _input: string): Promise<TuiWorkspaceCommandResult | undefined> {
		return undefined;
	}

	// workspace ledger helpers (see the section comment above)

	private workspaceKey(path: string): string {
		const abs = resolve(path);
		return platform() === "win32" ? abs.toLowerCase() : abs;
	}

	private loadWorkspaces(): WorkspaceRecord[] {
		if (this.workspaces !== undefined) return this.workspaces;
		let list: WorkspaceRecord[] = [];
		try {
			const raw = JSON.parse(readFileSync(this.workspacesPath, "utf8")) as unknown;
			if (Array.isArray(raw)) {
				list = raw.filter(
					(entry): entry is WorkspaceRecord =>
						typeof entry === "object" &&
						entry !== null &&
						typeof (entry as WorkspaceRecord).id === "string" &&
						typeof (entry as WorkspaceRecord).path === "string" &&
						typeof (entry as WorkspaceRecord).title === "string",
				);
			}
		} catch {
			// Missing/corrupt ledger starts empty; the launch cwd reseeds it.
		}
		this.workspaces = list;
		return list;
	}

	private saveWorkspaces(): void {
		try {
			mkdirSync(dirname(this.workspacesPath), { recursive: true });
			writeFileSync(this.workspacesPath, JSON.stringify(this.workspaces ?? [], null, 2));
		} catch {}
	}

	private findWorkspace(path: string): WorkspaceRecord | undefined {
		const key = this.workspaceKey(path);
		return this.loadWorkspaces().find((w) => this.workspaceKey(w.path) === key);
	}

	private ensureWorkspace(path: string, title?: string): WorkspaceRecord {
		const existing = this.findWorkspace(path);
		if (existing) return existing;
		const abs = resolve(path);
		const record: WorkspaceRecord = {
			id: randomUUID(),
			path: abs,
			title: title?.trim() || basename(abs) || abs,
		};
		this.loadWorkspaces().push(record);
		this.saveWorkspaces();
		return record;
	}

	private workspaceTarget(path: string): TuiWorkspaceTarget {
		const abs = resolve(path);
		return { uri: abs, cwd: abs, label: basename(abs) || abs, kind: "local", badge: "local" };
	}

	// ─── model / effort ────────────────────────────────────────────────

	async switchModel(provider: string, model: string): Promise<boolean> {
		try {
			const snapshot = this._session.modelRuntime.getAvailableSnapshot?.() ?? [];
			const found = snapshot.find((m: { provider: string; id: string }) => m.provider === provider && m.id === model)
				?? snapshot.find((m: { provider: string; id: string }) => m.id === model);
			if (!found) {
				this.notify(`Model not found: ${provider}/${model}`, { color: "error" });
				return false;
			}
			await this.session.setModel(found as never);
			this.emit();
			return true;
		} catch (err) {
			this.notify(`Model switch failed: ${err instanceof Error ? err.message : String(err)}`, { color: "error" });
			return false;
		}
	}

	async listEfforts(): Promise<{ efforts: readonly EffortOption[]; defaultEffort: string | undefined }> {
		const levels = this.effortLevels ?? [];
		return {
			efforts: levels.map((id) => ({ id, name: id })),
			defaultEffort: this._session.thinkingLevel,
		};
	}

	async setEffort(id: string): Promise<boolean> {
		const levels = this.effortLevels ?? [];
		if (!levels.includes(id)) {
			this.notify(`Unknown effort level: ${id}`, { color: "error" });
			return false;
		}
		try {
			this._session.setThinkingLevel(id as never);
			this.emit();
			return true;
		} catch (err) {
			this.notify(`Effort failed: ${err instanceof Error ? err.message : String(err)}`, { color: "error" });
			return false;
		}
	}

	setDefaultEffort(id: string | undefined): void {
		if (id !== undefined) void this.setEffort(id);
	}

	async cycleMode(): Promise<void> {
		this.cycleThinking();
	}

	private cycleThinking(): void {
		try {
			const next = this._session.cycleThinkingLevel();
			if (next) this.notify(`Thinking: ${next}`, { timeoutMs: 2500 });
		} catch {}
	}

	permissionPresets(): PermissionPresetSnapshot {
		return { availability: "unavailable", options: [] };
	}

	async runPermissionPreset(_name: string): Promise<boolean> {
		this.notify("Permission presets are not supported by the pi backend", { color: "warning" });
		return false;
	}

	async listPresets(): Promise<readonly PresetOption[]> {
		return [];
	}

	async switchPreset(_presetId: string): Promise<boolean> {
		this.notify("Agent presets are not supported by the pi backend", { color: "warning" });
		return false;
	}

	// ─── transcript-local actions ──────────────────────────────────────

	clear(): void {
		this.rowList.length = 0;
		this.toolRows.clear();
		this.groupStart = -1;
		this.groupRowIds = [];
		this.rowList.push({ id: this.rowSeq++, kind: "notice", text: "Session cleared" });
		this.emit();
	}

	loadOlder(): number {
		return 0;
	}

	notify(text: string, options?: { color?: NotificationItem["color"]; timeoutMs?: number }): () => void {
		const item: NotificationItem = { id: ++this.notifySeq, text, color: options?.color, timeoutMs: options?.timeoutMs ?? 4000 };
		this.noticeItems.push(item);
		this.emit();
		let dismissed = false;
		const dismiss = () => {
			if (dismissed) return;
			dismissed = true;
			const i = this.noticeItems.indexOf(item);
			if (i !== -1) {
				this.noticeItems.splice(i, 1);
				this.emit();
			}
		};
		if (item.timeoutMs > 0) setTimeout(dismiss, item.timeoutMs).unref?.();
		return dismiss;
	}

	setActivityFrames(name: string): boolean {
		this.prefs.activityFrames = name;
		this.writePrefs();
		this.emit();
		return true;
	}

	async listModels(): Promise<readonly LlmModelInfo[]> {
		const snapshot = this._session.modelRuntime.getAvailableSnapshot?.() ?? [];
		return snapshot.map((m: { provider: string; id: string; name?: string }) => ({
			provider: m.provider,
			id: m.id,
			name: m.name ?? m.id,
		}));
	}

	async listProviders(): Promise<readonly LlmProviderInfo[]> {
		const models = await this.listModels();
		const providers = new Set(models.map((m) => m.provider));
		return [...providers].map((id) => ({ id, name: id }));
	}

	invalidateModelCompletion(): void {}

	async listSkills(): Promise<readonly SkillInfo[] | undefined> {
		try {
			const skills = this._session.resourceLoader?.getSkills?.().skills ?? [];
			return skills.map((s: { name: string; description?: string }) => ({
				name: s.name,
				description: s.description ?? "",
				userInvocable: true,
				source: "pi",
			}));
		} catch {
			return undefined;
		}
	}

	async describeCredential(_ref: string): Promise<CredentialStatus | undefined> {
		return undefined;
	}

	async balanceInfo(): Promise<BalanceResult> {
		return { ok: false, reason: "no-key" };
	}

	providerSetup(): ProviderSetupHost | undefined {
		return undefined;
	}

	async oauthProviderStatuses(): Promise<readonly OAuthProviderStatus[] | undefined> {
		return undefined;
	}

	settingsHost(): SettingsHost | undefined {
		return undefined;
	}

	settingsSections(): readonly TuiSettingsSection[] {
		return [];
	}

	subscribeSettingsSections(_listener: () => void): () => void {
		return () => {};
	}

	// ─── files / @-completion ──────────────────────────────────────────

	async listFileCandidates(query: string, options?: { signal?: AbortSignal; topK?: number }): Promise<readonly FileCandidate[]> {
		const topK = options?.topK ?? 50;
		const q = query.toLowerCase();
		const results: FileCandidate[] = [];
		const skip = new Set([".git", "node_modules", "dist", ".venv", "__pycache__", ".next", "target"]);
		const walk = (dir: string, depth: number) => {
			if (results.length >= topK || depth > 6 || options?.signal?.aborted) return;
			let entries;
			try {
				entries = readdirSync(dir, { withFileTypes: true });
			} catch {
				return;
			}
			for (const e of entries) {
				if (results.length >= topK) return;
				if (e.name.startsWith(".") && e.name !== ".") continue;
				if (skip.has(e.name)) continue;
				const abs = join(dir, e.name);
				const rel = relative(this.cwd, abs) || e.name;
				if (q === "" || rel.toLowerCase().includes(q) || e.name.toLowerCase().includes(q)) {
					results.push({
						id: rel,
						path: abs,
						displayPath: rel + (e.isDirectory() ? sep : ""),
						name: e.name,
						kind: e.isDirectory() ? "directory" : "file",
						score: rel.toLowerCase().startsWith(q) ? 2 : 1,
					});
				}
				if (e.isDirectory()) walk(abs, depth + 1);
			}
		};
		walk(this.cwd, 0);
		results.sort((a, b) => b.score - a.score || a.displayPath.length - b.displayPath.length);
		return results.slice(0, topK);
	}

	async listFiles(): Promise<readonly string[]> {
		const candidates = await this.listFileCandidates("", { topK: 2000 });
		return candidates.map((c) => c.displayPath);
	}

	// ─── persisted sessions ────────────────────────────────────────────

	private async resolveSessionPath(sessionId: string): Promise<string | undefined> {
		const cached = this.sessionPathCache.get(sessionId);
		if (cached && existsSync(cached)) return cached;
		if (this._session.sessionFile && this.sessionId === sessionId) return this._session.sessionFile;
		try {
			const all = await SessionManager.listAll();
			const hit = all.find((s) => s.id === sessionId || s.id.startsWith(sessionId));
			if (hit) {
				this.sessionPathCache.set(hit.id, hit.path);
				return hit.path;
			}
		} catch {}
		const direct = SessionManager.findById(this.cwd, sessionId, this.opts.sessionDir);
		return direct;
	}

	async listSessions(onEnriched?: (summary: SessionSummary) => void): Promise<readonly SessionSummary[]> {
		// No --session-dir → unscoped scan so the workspace rail sees every
		// cwd's sessions; an explicit dir scopes the listing to it.
		const infos = await (this.opts.sessionDir
			? SessionManager.listAll(this.opts.sessionDir)
			: SessionManager.listAll()
		).catch(() => []);
		const summaries: SessionSummary[] = infos.map((s) => {
			this.sessionPathCache.set(s.id, s.path);
			const summary: SessionSummary = {
				id: s.id,
				kind: s.parentSessionPath ? { kind: "fork", parent: s.parentSessionPath } : { kind: "root" },
				title: { text: s.name || previewText(s.firstMessage || basename(s.cwd || ""), 60), source: s.name ? "renamed" : s.firstMessage ? "prompt" : "fallback" },
				cwd: s.cwd ?? "",
				createdAt: s.created instanceof Date ? s.created.getTime() : Date.now(),
				updatedAt: s.modified instanceof Date ? s.modified.getTime() : Date.now(),
				bytes: (() => {
					try {
						return statSync(s.path).size;
					} catch {
						return undefined;
					}
				})(),
				hasPrompt: s.messageCount > 0,
				agentPreset: undefined,
				model: undefined,
				label: undefined,
				branch: undefined,
				childCount: 0,
			};
			return summary;
		});
		if (onEnriched) for (const s of summaries) onEnriched(s);
		return summaries;
	}

	async previewSession(sessionId: string): Promise<readonly PreviewEntry[]> {
		const path = await this.resolveSessionPath(sessionId);
		if (!path) return [];
		try {
			const sm = SessionManager.open(path);
			const messages = sm.buildSessionContext().messages.slice(-12);
			return messages
				.filter((m) => m.role === "user" || m.role === "assistant")
				.map((m) => ({
					role: m.role as "user" | "assistant",
					text: previewText(contentText((m as { content?: unknown }).content), 200),
					at: (m as { timestamp?: number }).timestamp,
				}));
		} catch {
			return [];
		}
	}

	setResumeTarget(sessionId: string): void {
		this.prefs.resumeTarget = sessionId;
		this.writePrefs();
	}

	renameSession(title: string): void {
		this._session.setSessionName(title);
		this._sessionTitle = title;
		this.emit();
	}

	setSessionColor(color: string): void {
		this._sessionColor = color;
		this.emit();
	}

	async recapRecent(_options?: { signal?: AbortSignal; onText?: (delta: string) => void }): Promise<RecapOutcome> {
		return { summary: null, error: "Recap is not supported by the pi backend" };
	}

	async deleteSession(sessionId: string): Promise<boolean> {
		const path = await this.resolveSessionPath(sessionId);
		if (!path) return false;
		if (this._session.sessionFile && path === this._session.sessionFile) {
			this.notify("Cannot delete the live session", { color: "warning" });
			return false;
		}
		try {
			unlinkSync(path);
			this.sessionPathCache.delete(sessionId);
			return true;
		} catch {
			return false;
		}
	}

	async renameSessionTo(sessionId: string, title: string): Promise<boolean> {
		if (sessionId === this.sessionId) {
			this.renameSession(title);
			return true;
		}
		const path = await this.resolveSessionPath(sessionId);
		if (!path) return false;
		try {
			SessionManager.open(path).appendSessionInfo(title);
			return true;
		} catch {
			return false;
		}
	}

	compact(customInstructions?: string): void {
		void this.session
			.compact(customInstructions)
			.catch((err) => this.notify(`Compaction failed: ${err instanceof Error ? err.message : String(err)}`, { color: "error" }));
	}

	cancelCompact(): void {
		this._session.abortCompaction();
	}

	pushLocal(title: string, lines: readonly string[]): void {
		this.rowList.push({ id: this.rowSeq++, kind: "local", text: title });
		for (const line of lines) {
			this.rowList.push({ id: this.rowSeq++, kind: "local-output", text: line });
		}
		this.emit();
	}

	mcpStatus(): string[] {
		return ["MCP servers are managed by pi; this build has no MCP status surface."];
	}

	exportSession(targetPath?: string): string | null {
		try {
			const path = targetPath ?? join(this.cwd, `butterpi-export-${new Date().toISOString().replace(/[:.]/g, "-")}.md`);
			const lines: string[] = [`# ${this._sessionTitle || "butterpi session"}`, ""];
			for (const m of this._session.messages) {
				if (m.role === "user") lines.push(`## You`, "", contentText((m as { content?: unknown }).content), "");
				else if (m.role === "assistant") {
					const text = (m as AssistantMessage).content
						.filter((c) => c.type === "text")
						.map((c) => (c as TextContent).text)
						.join("\n");
					if (text.trim()) lines.push("## Assistant", "", text, "");
				}
			}
			writeFileSync(path, lines.join("\n"));
			return path;
		} catch {
			return null;
		}
	}

	initWorkspace(): string | null {
		try {
			const path = join(this.cwd, "AGENTS.md");
			if (existsSync(path)) return "exists";
			writeFileSync(path, "# AGENTS.md\n\n");
			return path;
		} catch {
			return null;
		}
	}

	doctorInfo(): string[] {
		return [
			`butterpi (dsh-TUI renderer, pi backend)`,
			`node ${process.version} · ${platform()} ${process.arch}`,
			`cwd ${this.cwd}`,
			`session ${this.sessionId}${this._session.sessionFile ? ` · ${this._session.sessionFile}` : " (in-memory)"}`,
			`model ${this.provider}/${this.model || "none"}`,
			`agentDir ${this.agentDir()}`,
		];
	}

	pluginsInfo(_args: string): string[] {
		return ["pi extension runtime: plugins load via ~/.pi/agent extensions"];
	}

	async listSubagents(): Promise<string[]> {
		return ["Subagents are not supported by the pi backend."];
	}

	private _agentViewSnapshot: readonly AgentViewRow[] = [];
	private _agentViewKey = "";

	agentViewRows(): readonly AgentViewRow[] {
		// useSyncExternalStore snapshot — must be referentially stable between
		// channel mutations; rebuild only when the visible fields change.
		const key = [
			this.sessionId,
			this._sessionTitle,
			this.cwd,
			this._lastUserText,
			this._working,
			this._turnStart,
		].join("");
		if (key !== this._agentViewKey) {
			this._agentViewKey = key;
			const now = Date.now();
			this._agentViewSnapshot = [
				{
					id: this.sessionId,
					title: this._sessionTitle || basename(this.cwd) || "session",
					cwd: this.cwd,
					summary: this._lastUserText || "",
					status: this._working ? "working" : "idle",
					live: true,
					current: true,
					createdAt: this._turnStart || now,
					updatedAt: now,
				},
			];
		}
		return this._agentViewSnapshot;
	}

	subscribeAgentView(listener: () => void): () => void {
		return this.subscribe(listener);
	}

	async dispatchBackgroundAgent(_prompt: string): Promise<AgentViewDispatchResult> {
		return { ok: false, reason: "unavailable" };
	}

	async stopBackgroundAgent(_sessionId: string): Promise<boolean> {
		return false;
	}

	async attachToAgent(sessionId: string): Promise<ResumeResult> {
		return this.resumeTo(sessionId);
	}

	async peekAgentSession(sessionId: string): Promise<readonly PreviewEntry[]> {
		return this.previewSession(sessionId);
	}

	async backgroundCurrent(): Promise<BackgroundResult> {
		return { ok: false };
	}

	async replyToAgent(_sessionId: string, _text: string): Promise<boolean> {
		return false;
	}

	traceEvents(): readonly RawTrajEvent[] {
		// extendTrajectory detects appends by comparing the snapshot's tail
		// element across calls — it needs an immutable view, so hand out a
		// memoized copy rather than the live array (which always looks
		// identical to its own previous source and would freeze the fold).
		if (this._trajFrozen.length !== this._traj.length) {
			this._trajFrozen = this._traj.slice();
		}
		return this._trajFrozen;
	}

	// ─── preferences setters ───────────────────────────────────────────

	private setPref<K extends keyof ButterPrefs>(key: K, value: ButterPrefs[K]): void {
		this.prefs[key] = value;
		this.writePrefs();
		this.emit();
	}

	setDiffLayout(layout: "auto" | "split" | "unified"): void {
		if (DIFF_LAYOUT_SET.has(layout)) this.setPref("diffLayout", layout);
	}

	setThinkingFold(mode: "preview" | "full"): void {
		this.setPref("thinkingFold", mode === "full" ? "full" : "preview");
	}

	setToolBackground(background: ToolBackground): void {
		if (TOOL_BACKGROUND_SET.has(background)) this.setPref("toolBackground", background);
	}

	setScrollGutter(mode: ScrollGutterMode): void {
		if (SCROLL_GUTTER_SET.has(mode)) this.setPref("scrollGutter", mode);
	}

	setPageMargin(setting: PageMarginSetting): void {
		this.setPref("pageMargin", setting);
		applyPageMargin(setting);
	}

	setFoldTerminalCommand(enabled: boolean): void {
		this.setPref("foldTerminalCommand", enabled);
	}

	setPromptSessionLabel(enabled: boolean): void {
		this.setPref("promptSessionLabel", enabled);
	}

	setExpandEditor(enabled: boolean): void {
		this.setPref("expandEditor", enabled);
	}

	setSmoothStreaming(enabled: boolean): void {
		this.setPref("smoothStreaming", enabled);
	}

	setStatusBar(config: Partial<StatusBarConfig>): void {
		this.setPref("statusBar", { ...(this.prefs.statusBar ?? {}), ...config });
	}

	setWhale(visible: boolean): void {
		this.setPref("whale", visible);
	}

	setSplashFont(setting: SplashFontSetting): void {
		this.setPref("splashFont", setting);
	}

	setMinimal(enabled: boolean): void {
		this.setPref("minimal", enabled);
	}

	setWhaleIdle(enabled: boolean): void {
		this.setPref("whaleIdle", enabled);
	}

	setWhaleGirl(enabled: boolean): void {
		this.setPref("whaleGirl", enabled);
	}

	// ─── commands ──────────────────────────────────────────────────────

	commandCompletions(input: string): readonly CommandCompletion[] {
		return completeCommands(input, this.commandList);
	}

	async runExternalCommand(name: string, rawInput: string, images?: readonly ComposerImageRef[]): Promise<string | undefined> {
		const outcome = await this.runExternalCommandOutcome(name, rawInput, images);
		return outcome?.text;
	}

	async runExternalCommandOutcome(
		name: string,
		rawInput: string,
		images?: readonly ComposerImageRef[],
	): Promise<ExternalCommandOutcome | undefined> {
		const line = `/${name}${rawInput}`;
		// butterpi-internal extras (kept for muscle memory).
		switch (name) {
			case "name": {
				const title = rawInput.trim();
				this.renameSession(title);
				return { kind: "success", text: title ? `Session: ${title}` : "Name cleared", consumeDraft: true };
			}
			case "copy": {
				const last = this._session.getLastAssistantText();
				if (!last) return { kind: "error", text: "Nothing to copy", consumeDraft: true };
				try {
					const { copyToClipboard } = await import("@earendil-works/pi-coding-agent");
					await copyToClipboard(last);
					return { kind: "success", text: "Copied last message", consumeDraft: true };
				} catch {
					return { kind: "error", text: "Clipboard unavailable", consumeDraft: true };
				}
			}
			case "session":
			case "stats": {
				const st = this._session.getSessionStats();
				this.pushLocal(line, [
					`session   ${st.sessionId}`,
					`file      ${st.sessionFile ?? "(in-memory)"}`,
					`messages  ${st.totalMessages} (${st.userMessages} user / ${st.assistantMessages} assistant)`,
					`tools     ${st.toolCalls} calls`,
					`tokens    in ${st.tokens.input} · out ${st.tokens.output} · cache r/w ${st.tokens.cacheRead}/${st.tokens.cacheWrite}`,
					`cost      $${st.cost.toFixed(4)}`,
					...(st.contextUsage ? [`context   ${st.contextUsage.tokens ?? "?"} / ${st.contextUsage.contextWindow}`] : []),
				]);
				return { kind: "success", text: "", consumeDraft: true };
			}
			case "trust": {
				try {
					const { ProjectTrustStore } = await import("@earendil-works/pi-coding-agent");
					new ProjectTrustStore(this.agentDir()).set(this.cwd, true);
					return { kind: "success", text: "Trusted — restart butterpi to apply", consumeDraft: true };
				} catch (err) {
					return { kind: "error", text: String(err), consumeDraft: true };
				}
			}
			case "clone": {
				// pi's /clone: fork at the current leaf (position "at").
				const leaf = this._session.sessionManager.getLeafId();
				if (!leaf) return { kind: "error", text: "Nothing to clone yet", consumeDraft: true };
				try {
					const r = await this.runtime.fork(leaf, { position: "at" });
					if (r.cancelled) return { kind: "success", text: "Clone cancelled", consumeDraft: true };
					return { kind: "success", text: "Cloned to new session", consumeDraft: true };
				} catch (err) {
					return { kind: "error", text: `Clone failed: ${err instanceof Error ? err.message : String(err)}`, consumeDraft: true };
				}
			}
			case "reload": {
				if (this._session.isStreaming || this._session.isCompacting) {
					return { kind: "error", text: "Wait for the current response to finish before reloading", consumeDraft: true };
				}
				try {
					// Same session object survives reload — only the transcript
					// needs rebuilding; a full bindSession would bump the binding
					// generation (suppressing this very toast) and re-fire the
					// extension binder on top of session.reload's own rebinding.
					await this._session.reload({ beforeSessionStart: () => this.rebuildTranscript() });
					this.emit();
					return { kind: "success", text: "Reloaded keybindings, extensions, skills, prompts, themes, and context files", consumeDraft: true };
				} catch (err) {
					return { kind: "error", text: `Reload failed: ${err instanceof Error ? err.message : String(err)}`, consumeDraft: true };
				}
			}
			case "import": {
				const inputPath = this.commandPathArg(rawInput);
				if (!inputPath) return { kind: "error", text: "Usage: /import <path.jsonl>", consumeDraft: true };
				if (!this.dialogs) return { kind: "error", text: "Dialogs unavailable in this frontend", consumeDraft: true };
				const ok = await this.askConfirm("Import session", `Replace current session with ${inputPath}?`);
				if (!ok) return { kind: "success", text: "Import cancelled", consumeDraft: true };
				try {
					const r = await this.runtime.importFromJsonl(inputPath);
					if (r.cancelled) return { kind: "success", text: "Import cancelled", consumeDraft: true };
					return { kind: "success", text: `Session imported from: ${inputPath}`, consumeDraft: true };
				} catch (err) {
					if (err instanceof Error && err.name === "MissingSessionCwdError") {
						const selectedCwd = await this.askInput("Session cwd missing", "Enter working directory for this session:");
						if (!selectedCwd) return { kind: "success", text: "Import cancelled", consumeDraft: true };
						try {
							const r2 = await this.runtime.importFromJsonl(inputPath, selectedCwd);
							if (r2.cancelled) return { kind: "success", text: "Import cancelled", consumeDraft: true };
							return { kind: "success", text: `Session imported from: ${inputPath}`, consumeDraft: true };
						} catch (err2) {
							return { kind: "error", text: `Failed to import session: ${err2 instanceof Error ? err2.message : String(err2)}`, consumeDraft: true };
						}
					}
					return { kind: "error", text: `Failed to import session: ${err instanceof Error ? err.message : String(err)}`, consumeDraft: true };
				}
			}
			case "export": {
				const outputPath = this.commandPathArg(rawInput);
				try {
					const filePath = outputPath?.endsWith(".jsonl")
						? this._session.exportToJsonl(outputPath)
						: outputPath?.endsWith(".md")
							? (this.exportSession(outputPath) ?? (() => { throw new Error("export failed") })())
							: await this._session.exportToHtml(outputPath ?? undefined);
					return { kind: "success", text: `Session exported to: ${filePath}`, consumeDraft: true };
				} catch (err) {
					return { kind: "error", text: `Failed to export session: ${err instanceof Error ? err.message : "Unknown error"}`, consumeDraft: true };
				}
			}
			case "share":
				return this.shareViaGist();
			case "bug":
				return this.reportBugLocal(rawInput.trim());
			case "changelog":
				return this.showChangelog();
			case "scoped-models": {
				const input = rawInput.trim();
				const runtime = this._session.modelRuntime;
				if (!input) {
					const scoped = this._session.scopedModels;
					const current = scoped.length > 0 ? scoped.map((s) => `${s.model.provider}/${s.model.id}`) : [];
					this.pushLocal(line, [
						current.length > 0 ? `Scoped models (${current.length}):` : "No session-scoped models — Ctrl+P cycles every available model.",
						...current.map((m) => `  ${m}`),
						"",
						"Usage: /scoped-models <pattern>… — e.g. /scoped-models fake/* gpt-4*",
						"       /scoped-models all — clear the scope",
					]);
					return { kind: "success", text: "", consumeDraft: true };
				}
				if (input === "all" || input === "*") {
					this._session.setScopedModels([]);
					return { kind: "success", text: "Model scope cleared — all models cycle", consumeDraft: true };
				}
				try {
					const patterns = input.split(/\s+/).filter(Boolean);
					const { resolveModelScopeWithDiagnostics } = await import("@earendil-works/pi-coding-agent");
					const resolved = await resolveModelScopeWithDiagnostics(patterns, runtime, { signal: AbortSignal.timeout(15_000) });
					const unmatched = resolved.diagnostics.filter((d: { code: string }) => d.code === "no-match");
					this._session.setScopedModels(resolved.scopedModels.map((s) => ({ model: s.model, thinkingLevel: s.thinkingLevel })));
					this.emit();
					const names = resolved.scopedModels.map((s) => `${s.model.provider}/${s.model.id}`);
					const warn = unmatched.length > 0 ? ` (no match: ${unmatched.map((d: { pattern: string }) => d.pattern).join(", ")})` : "";
					return { kind: "success", text: `Scoped ${names.length} model(s): ${names.join(", ")}${warn}`, consumeDraft: true };
				} catch (err) {
					return { kind: "error", text: `Failed to scope models: ${err instanceof Error ? err.message : String(err)}`, consumeDraft: true };
				}
			}
			case "settings":
				return this.openSettingsMenu();
			case "login":
				return this.loginCommand(rawInput.trim());
			case "logout":
				return this.logoutCommand();
		}
		// pi extension commands run through session.prompt()'s dispatch, which
		// also expands skill commands and prompt templates.
		const hasExtension = (() => {
			try {
				return this._session.extensionRunner?.getCommand?.(name) !== undefined;
			} catch {
				return false;
			}
		})();
		const hasTemplate = (this._session.promptTemplates ?? []).some((t) => t.name === name);
		if (!hasExtension && !hasTemplate) return undefined;
		try {
			await this.session.prompt(line, { images: this.imagesFromRefs(images) });
			return { kind: "success", text: "", consumeDraft: true };
		} catch (err) {
			return { kind: "error", text: err instanceof Error ? err.message : String(err), consumeDraft: true };
		}
	}

	// ─── pi command helpers ────────────────────────────────────────────

	/** First argument of a slash command, honoring pi's quoted-path grammar. */
	private commandPathArg(rawInput: string): string | undefined {
		const argsString = rawInput.trimStart();
		if (!argsString) return undefined;
		const firstChar = argsString[0];
		if (firstChar === '"' || firstChar === "'") {
			const closing = argsString.indexOf(firstChar, 1);
			return closing < 0 ? undefined : argsString.slice(1, closing);
		}
		const ws = argsString.search(/\s/);
		return ws < 0 ? argsString : argsString.slice(0, ws);
	}

	private askSelect(title: string, options: { id: string; label: string; description?: string }[]): Promise<string | undefined> {
		return this.dialogs!.ask({ kind: "select", title, options }).then((v) => (typeof v === "string" ? v : undefined));
	}

	private askConfirm(title: string, message: string): Promise<boolean> {
		return this.dialogs!.ask({ kind: "confirm", title, message, confirmLabel: "Yes", cancelLabel: "No" }).then((v) => v === true);
	}

	private askInput(title: string, placeholder?: string): Promise<string | undefined> {
		return this.dialogs!.ask({ kind: "input", title, placeholder, initial: "" }).then((v) => (typeof v === "string" ? v : undefined));
	}

	/** pi /share: export the branch to HTML and upload it as a secret gist. */
	private async shareViaGist(): Promise<ExternalCommandOutcome> {
		const tempDir = mkdtempSync(join(tmpdir(), "butterpi-share-"));
		const htmlFile = join(tempDir, "session.html");
		try {
			try {
				await this._session.exportToHtml(htmlFile);
			} catch (err) {
				return { kind: "error", text: `Failed to export session: ${err instanceof Error ? err.message : "Unknown error"}`, consumeDraft: true };
			}
			const auth = spawnSync("gh", ["auth", "status"], { encoding: "utf-8", windowsHide: true });
			if (auth.error) {
				return { kind: "error", text: "GitHub CLI (gh) is not installed. Install it from https://cli.github.com/", consumeDraft: true };
			}
			if (auth.status !== 0) {
				return { kind: "error", text: "GitHub CLI is not logged in. Run 'gh auth login' first.", consumeDraft: true };
			}
			this.notify("Creating gist…", { timeoutMs: 15_000 });
			const result = spawnSync("gh", ["gist", "create", "--public=false", htmlFile], { encoding: "utf-8", timeout: 60_000, windowsHide: true });
			if (result.error || result.status !== 0) {
				return { kind: "error", text: `Failed to create gist: ${result.stderr?.trim() || result.error?.message || "Unknown error"}`, consumeDraft: true };
			}
			const gistUrl = result.stdout?.trim() ?? "";
			const gistId = gistUrl.split("/").pop();
			if (!gistId) return { kind: "error", text: "Failed to parse gist ID from gh output", consumeDraft: true };
			const viewer = `${process.env.PI_SHARE_VIEWER_URL ?? "https://pi.dev/session/"}#${gistId}`;
			return { kind: "success", text: `Share URL: ${viewer}\nGist: ${gistUrl}`, consumeDraft: true };
		} finally {
			try {
				rmSync(tempDir, { recursive: true, force: true });
			} catch {}
		}
	}

	/**
	 * pi /bug writes a report bundle (metadata + optional transcript). The
	 * Radius upload channel is pi-developer infrastructure, so butterpi always
	 * takes the "export as zip" arm: a folder in cwd, zipped when `zip` exists.
	 */
	private async reportBugLocal(hint?: string): Promise<ExternalCommandOutcome> {
		if (!this.dialogs) return { kind: "error", text: "Dialogs unavailable in this frontend", consumeDraft: true };
		const description = (hint ?? (await this.askInput("Report a bug", "What went wrong? (optional)")) ?? "").trim();
		const include = await this.askConfirm(
			"Include the session transcript?",
			"The transcript contains your messages, model output, tool calls and results — including file contents and command output read during this session.",
		);
		const stamp = new Date().toISOString().replace(/[:.]/g, "-");
		const dir = join(this.cwd, `butterpi-bug-report-${stamp}`);
		try {
			mkdirSync(dir, { recursive: true });
			const stats = this._session.getSessionStats();
			const report = [
				"# butterpi bug report",
				"",
				`- date: ${new Date().toISOString()}`,
				`- os: ${platform()} ${process.arch}`,
				`- node: ${process.version}`,
				`- session: ${stats.sessionId}`,
				`- file: ${stats.sessionFile ?? "(in-memory)"}`,
				`- model: ${this.provider}/${this.model || "none"}`,
				`- messages: ${stats.totalMessages} (${stats.userMessages} user / ${stats.assistantMessages} assistant)`,
				`- transcript: ${include ? "included (session.jsonl)" : "not included"}`,
				"",
				"## Description",
				"",
				description || "(none)",
				"",
			].join("\n");
			writeFileSync(join(dir, "REPORT.md"), report);
			if (include) this._session.exportToJsonl(join(dir, "session.jsonl"));
			let target = dir;
			try {
				execFileSync("zip", ["-qr", `${dir}.zip`, basename(dir)], { cwd: this.cwd });
				rmSync(dir, { recursive: true, force: true });
				target = `${dir}.zip`;
			} catch {
				// no zip binary — keep the folder
			}
			return { kind: "success", text: `Bug report exported to: ${target}`, consumeDraft: true };
		} catch (err) {
			return { kind: "error", text: `Failed to write bug report: ${err instanceof Error ? err.message : String(err)}`, consumeDraft: true };
		}
	}

	/** pi /changelog: render the packaged CHANGELOG.md (latest entries first). */
	private async showChangelog(): Promise<ExternalCommandOutcome> {
		try {
			const path = await codingAgentDistPath("CHANGELOG.md");
			const text = existsSync(path) ? readFileSync(path, "utf-8") : "";
			const entries = text
				.split(/^## /m)
				.slice(1)
				.map((e) => `## ${e.trim()}`)
				.slice(0, 5);
			const lines = entries.length > 0 ? entries : ["No changelog entries found."];
			this.pushLocal("pi changelog", [...lines, "", `(source: ${path})`]);
			return { kind: "success", text: "", consumeDraft: true };
		} catch (err) {
			return { kind: "error", text: `Changelog unavailable: ${err instanceof Error ? err.message : String(err)}`, consumeDraft: true };
		}
	}

	/** pi /settings equivalent: pick a preference, then pick its value. */
	private async openSettingsMenu(): Promise<ExternalCommandOutcome> {
		if (!this.dialogs) return { kind: "error", text: "Dialogs unavailable in this frontend", consumeDraft: true };
		const { PRESET_NAMES } = await import("./vendor/dsh/components/activityFrames.js");
		type PrefEntry = {
			id: string;
			label: string;
			current: () => string;
			options?: readonly string[];
			apply: (value?: string) => void;
		};
		const entries: PrefEntry[] = [
			{ id: "pageMargin", label: "Page margin", current: () => String(this.pageMargin), options: ["none", "slim", "normal", "roomy"], apply: (v) => this.setPageMargin(v as never) },
			{ id: "scrollGutter", label: "Scroll gutter", current: () => this.scrollGutter, options: ["timeline", "scrollbar", "hidden"], apply: (v) => this.setScrollGutter(v as never) },
			{ id: "toolBackground", label: "Tool output background", current: () => this.toolBackground, options: ["none", "subtle", "strong"], apply: (v) => this.setToolBackground(v as never) },
			{ id: "diffLayout", label: "Diff layout", current: () => this.diffLayout, options: ["auto", "split", "unified"], apply: (v) => this.setDiffLayout(v as never) },
			{ id: "thinkingFold", label: "Thinking display", current: () => this.thinkingFold, options: ["preview", "full"], apply: (v) => this.setThinkingFold(v as never) },
			{ id: "smoothStreaming", label: "Smooth streaming", current: () => (this.prefs.smoothStreaming ? "on" : "off"), apply: () => this.setSmoothStreaming(!(this.prefs.smoothStreaming ?? true)) },
			{ id: "foldTerminalCommand", label: "Fold shell commands", current: () => (this.prefs.foldTerminalCommand ? "on" : "off"), apply: () => this.setFoldTerminalCommand(!(this.prefs.foldTerminalCommand ?? false)) },
			{ id: "expandEditor", label: "Expanded editor", current: () => (this.prefs.expandEditor ? "on" : "off"), apply: () => this.setExpandEditor(!(this.prefs.expandEditor ?? false)) },
			{ id: "minimal", label: "Minimal chrome", current: () => (this.prefs.minimal ? "on" : "off"), apply: () => this.setMinimal(!(this.prefs.minimal ?? false)) },
			{ id: "whale", label: "Header art", current: () => (this.prefs.whale === false ? "off" : "on"), apply: () => this.setWhale(!(this.prefs.whale ?? true)) },
			{ id: "whaleIdle", label: "Header idle motion", current: () => (this.prefs.whaleIdle ? "on" : "off"), apply: () => this.setWhaleIdle(!(this.prefs.whaleIdle ?? true)) },
			{ id: "whaleGirl", label: "Whale girl sprite", current: () => (this.prefs.whaleGirl ? "on" : "off"), apply: () => this.setWhaleGirl(!(this.prefs.whaleGirl ?? false)) },
			{ id: "splashFont", label: "Splash font", current: () => this.prefs.splashFont ?? "daily", options: ["daily", "bold", "square", "bevel", "wide", "dot", "stencil", "classic", "slab"], apply: (v) => this.setSplashFont(v as never) },
			{ id: "activityFrames", label: "Working animation", current: () => this.prefs.activityFrames ?? "default", options: PRESET_NAMES, apply: (v) => { if (v) this.setActivityFrames(v); } },
		];
		for (;;) {
			const id = await this.askSelect(
				"Settings",
				entries.map((e) => ({ id: e.id, label: `${e.label} — ${e.current()}` })),
			);
			if (!id) break;
			const entry = entries.find((e) => e.id === id);
			if (!entry) break;
			if (entry.options) {
				const value = await this.askSelect(entry.label, entry.options.map((o) => ({ id: o, label: o })));
				if (value === undefined) continue;
				entry.apply(value);
				this.notify(`${entry.label}: ${value}`);
			} else {
				entry.apply();
				this.notify(`${entry.label}: ${entry.current()}`);
			}
		}
		return { kind: "success", text: "", consumeDraft: true };
	}

	/** pi /login: provider picker → auth type → modelRuntime.login flow. */
	private async loginCommand(providerRef: string): Promise<ExternalCommandOutcome> {
		if (!this.dialogs) return { kind: "error", text: "Dialogs unavailable in this frontend", consumeDraft: true };
		const runtime = this._session.modelRuntime;
		type ProviderOption = { id: string; name: string; authType: "oauth" | "api_key"; method: Record<string, unknown> };
		const options: ProviderOption[] = [];
		for (const provider of runtime.getProviders()) {
			const auth = (provider as { auth?: { oauth?: { loginLabel?: string }; apiKey?: { login?: unknown } } }).auth ?? {};
			if (auth.oauth) options.push({ id: provider.id, name: provider.name, authType: "oauth", method: auth.oauth });
			if (auth.apiKey) options.push({ id: provider.id, name: provider.name, authType: "api_key", method: auth.apiKey });
		}
		if (options.length === 0) {
			return { kind: "error", text: "No login providers available", consumeDraft: true };
		}
		let picked: ProviderOption | undefined;
		if (providerRef) {
			const needle = providerRef.toLowerCase();
			const matches = options.filter((o) => o.id.toLowerCase() === needle || o.name.toLowerCase() === needle);
			if (matches.length === 0) return { kind: "error", text: `Unknown provider: ${providerRef}`, consumeDraft: true };
			if (matches.length === 1) picked = matches[0];
			else {
				const sel = await this.askSelect(
					`Select authentication method for ${matches[0]!.name}:`,
					matches.map((o) => ({
						id: `${o.id}::${o.authType}`,
						label: o.authType === "oauth" ? ((o.method as { loginLabel?: string }).loginLabel ?? "Sign in with an account") : "Sign in with an API key",
					})),
				);
				picked = matches.find((o) => `${o.id}::${o.authType}` === sel);
			}
		} else {
			const sel = await this.askSelect(
				"Select provider to login:",
				options.map((o) => ({
					id: `${o.id}::${o.authType}`,
					label: `${o.name} — ${o.authType === "oauth" ? ((o.method as { loginLabel?: string }).loginLabel ?? "account") : "API key"}`,
				})),
			);
			picked = options.find((o) => `${o.id}::${o.authType}` === sel);
		}
		if (!picked) return { kind: "success", text: "Login cancelled", consumeDraft: true };
		if (picked.authType === "api_key" && !(picked.method as { login?: unknown }).login) {
			return { kind: "error", text: `${picked.name} is configured outside butterpi (env vars / models.json)`, consumeDraft: true };
		}
		const controller = new AbortController();
		const dialogs = this.dialogs;
		try {
			await runtime.login(picked.id, picked.authType, {
				signal: controller.signal,
				prompt: async (prompt) => {
					if (prompt.signal?.aborted) throw new Error("Login cancelled");
					if (prompt.type === "select") {
						const v = await dialogs.ask(
							{ kind: "select", title: prompt.message, options: prompt.options.map((o) => ({ id: o.id, label: o.label, description: o.description })) },
							prompt.signal,
							300_000,
						);
						if (typeof v !== "string") throw new Error("Login cancelled");
						return v;
					}
					const v = await dialogs.ask(
						{ kind: "input", title: prompt.message, placeholder: prompt.placeholder ?? "", initial: "" },
						prompt.signal,
						300_000,
					);
					if (typeof v !== "string") throw new Error("Login cancelled");
					return v;
				},
				notify: (event) => {
					if (event.type === "auth_url") {
						this.pushLocal("/login", [`Open this URL to continue:`, event.url, ...(event.instructions ? [event.instructions] : [])]);
					} else if (event.type === "device_code") {
						this.pushLocal("/login", [`Code: ${event.userCode}`, `Verify at: ${event.verificationUri}`]);
					} else if (event.type === "info") {
						this.pushLocal("/login", [event.message, ...(event.links ?? []).map((l) => `${l.label ?? "link"}: ${l.url}`)]);
					} else {
						this.notify(event.message, { timeoutMs: 10_000 });
					}
				},
			});
			return { kind: "success", text: `Logged in to ${picked.name}`, consumeDraft: true };
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			if (msg === "Login cancelled") return { kind: "success", text: "Login cancelled", consumeDraft: true };
			return { kind: "error", text: `Failed to login to ${picked.name}: ${msg}`, consumeDraft: true };
		}
	}

	/** pi /logout: pick a stored credential, then modelRuntime.logout. */
	private async logoutCommand(): Promise<ExternalCommandOutcome> {
		if (!this.dialogs) return { kind: "error", text: "Dialogs unavailable in this frontend", consumeDraft: true };
		const runtime = this._session.modelRuntime;
		let creds: readonly { providerId: string; type: string }[];
		try {
			creds = await runtime.listCredentials({ signal: AbortSignal.timeout(15_000) });
		} catch (err) {
			return { kind: "error", text: `Could not read stored credentials: ${err instanceof Error ? err.message : String(err)}`, consumeDraft: true };
		}
		if (creds.length === 0) {
			return { kind: "success", text: "No stored credentials to remove — env vars and models.json config are unchanged", consumeDraft: true };
		}
		const sel = await this.askSelect(
			"Remove stored credential:",
			creds.map((c) => ({
				id: `${c.providerId}::${c.type}`,
				label: `${runtime.getProvider(c.providerId)?.name ?? c.providerId} — ${c.type}`,
			})),
		);
		const picked = creds.find((c) => `${c.providerId}::${c.type}` === sel);
		if (!picked) return { kind: "success", text: "Logout cancelled", consumeDraft: true };
		try {
			await runtime.logout(picked.providerId, { signal: AbortSignal.timeout(15_000) });
			const name = runtime.getProvider(picked.providerId)?.name ?? picked.providerId;
			return { kind: "success", text: `Logged out of ${name} — env vars and models.json config are unchanged`, consumeDraft: true };
		} catch (err) {
			return { kind: "error", text: `Logout failed: ${err instanceof Error ? err.message : String(err)}`, consumeDraft: true };
		}
	}

	openPluginScene(_id: string): boolean {
		return false;
	}

	closePluginScene(): void {}

	async sideQuestion(
		_question: string,
		options?: { signal?: AbortSignal; onText?: (delta: string) => void },
	): Promise<{ answer: string | null; error?: string }> {
		return { answer: null, error: "Side questions are not supported by the pi backend" };
	}

	// ─── local shell (`!` / `!!`) ──────────────────────────────────────

	private async runLocalCommand(command: string, includeInContext: boolean): Promise<void> {
		if (!command) {
			this.notify("Usage: !<command>", { color: "warning" });
			return;
		}
		const rowId = this.rowSeq++;
		this.rowList.push({ id: rowId, kind: "local", text: `!${command}`, executionTarget: "local" });
		const outId = this.rowSeq++;
		this.bashRowId = rowId;
		this.bashOutputId = outId;
		this.rowList.push({ id: outId, kind: "local-output", text: "", streaming: true });
		this.emit();
		try {
			const result = await this.session.executeBash(
				command,
				(chunk) => {
					const row = this.rowList.find((r) => r.id === outId);
					if (row) row.text += chunk;
					this.emitStream();
				},
				{ excludeFromContext: !includeInContext },
			);
			const row = this.rowList.find((r) => r.id === outId);
			if (row) {
				row.text = result.output || (result.cancelled ? "(cancelled)" : "(no output)");
				row.streaming = false;
				if (result.exitCode !== 0 && result.exitCode !== undefined) {
					row.text += `${row.text.endsWith("\n") || row.text === "" ? "" : "\n"}(exit ${result.exitCode})`;
				}
			}
		} catch (err) {
			const row = this.rowList.find((r) => r.id === outId);
			if (row) {
				row.text = err instanceof Error ? err.message : String(err);
				row.streaming = false;
			}
		}
		this.bashRowId = -1;
		this.bashOutputId = -1;
		this.emit();
	}

	// ─── session event projection ──────────────────────────────────────

	private bindSession(session: AgentSession, options: { replay: boolean }): void {
		this.unsubscribe?.();
		this._session = session;
		this.bindingGeneration++;
		this.rowList.length = 0;
		this.toolRows.clear();
		this.groupStart = -1;
		this.groupRowIds = [];
		this.groupStreaming = false;
		this._pending = [];
		this._compaction = undefined;
		this._activeToolCount = 0;
		this._responseChars = 0;
		this._working = session.isStreaming;
		this._sessionTitle = session.sessionName ?? "";
		this._tokens = {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			peak: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			idle: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		};
		this._lastUsage = undefined;
		this._trajReset();
		if (options.replay) this.replayHistory();
		this.unsubscribe = session.subscribe((e) => this.onSessionEvent(e));
		this.emit();
		void this.extensionBinder?.(session);
	}

	// ─── trajectory (traceEvents) ────────────────────────────────────────

	/**
	 * Rebuild the trajectory log for the newly bound session: replay the
	 * persisted entries as seed rows, then close the seed bracket so the
	 * scene dims inherited history. Live events translate from
	 * onSessionEvent afterwards.
	 */
	private _trajReset(): void {
		this._traj = [];
		this._trajFrozen = [];
		this._trajTurn = 0;
		this._trajStep = 0;
		this._trajChunkSeen.clear();
		this._trajRetryId = undefined;
		this._trajRetry = 0;
		try {
			const entries = this._session.sessionManager.getEntries?.() ?? [];
			for (const entry of entries) this._trajSeedEntry(entry);
		} catch {
			// History seeding is best-effort; a malformed old entry must not
			// block the session view.
		}
		this._trajPush("session/end-seed", Date.now());
	}

	private _trajPush(type: string, time: number, data?: unknown): void {
		this._traj.push({ type, seq: this._traj.length, time, data });
	}

	/** Translate one persisted SessionEntry into seed events. */
	private _trajSeedEntry(entry: SessionEntry): void {
		const time = Date.parse(entry.timestamp ?? "") || Date.now();
		switch (entry.type) {
			case "message": {
				const message = (entry as { message?: AgentMessage }).message;
				if (!message || typeof message !== "object") return;
				this._trajMessage(message, time);
				break;
			}
			case "compaction":
				this._trajPush("compaction/start", time, { reason: "recorded" });
				this._trajPush("compaction/end", time, {});
				break;
			case "model_change": {
				const m = entry as { provider?: string; modelId?: string };
				this._trajPush("request/header", time, {
					reason: "change",
					header: { config: { provider: m.provider, model: m.modelId } },
				});
				break;
			}
			default:
				break;
		}
	}

	/** Translate one AgentMessage (seed or settled) into trajectory events. */
	private _trajMessage(message: AgentMessage, time: number): void {
		const role = (message as { role?: string }).role;
		if (role === "user") {
			const m = message as { content?: unknown };
			this._trajPush("user/message", time, { content: this._trajContent(m.content), source: { kind: "user" } });
			return;
		}
		if (role === "assistant") {
			const m = message as AssistantMessage;
			this._trajPush("assistant/message", time, {
				turn: this._trajTurn,
				step: this._trajStep,
				message: { content: m.content },
				usage: m.usage,
			});
			for (const block of m.content ?? []) {
				if (block.type === "toolCall") {
					this._trajToolCall(block.id, block.name, block.arguments, time);
				}
			}
			return;
		}
		if (role === "toolResult") {
			const m = message as { toolCallId?: string; content?: unknown; isError?: boolean };
			if (typeof m.toolCallId === "string") {
				this._trajPush("tool/result", time, {
					message: { source: { callId: m.toolCallId }, content: m.content },
					error: m.isError ? {} : undefined,
				});
			}
		}
	}

	/** Normalize message content to the array shape firstText() reads. */
	private _trajContent(content: unknown): unknown {
		if (typeof content === "string") return [{ type: "text", text: content }];
		return content;
	}

	private _trajToolCall(callId: string | undefined, name: string, args: unknown, time: number): void {		let argsText: string | undefined;
		if (typeof args === "string") argsText = args;
		else if (args !== undefined) {
			try { argsText = JSON.stringify(args); } catch { argsText = undefined; }
		}
		this._trajPush("tool/call", time, {
			turn: this._trajTurn,
			step: this._trajStep,
			callId,
			name,
			arguments: argsText,
		});
	}

	/** Live AgentSessionEvent → trajectory events. */
	private _trajEvent(e: AgentSessionEvent): void {
		const now = Date.now();
		switch (e.type) {
			case "agent_start":
				this._trajTurn += 1;
				this._trajStep = 0;
				this._trajPush("turn/start", now, { turn: this._trajTurn });
				break;
			case "turn_start":
				this._trajStep += 1;
				this._trajPush("step/start", now, { turn: this._trajTurn, step: this._trajStep });
				break;
			case "turn_end":
				this._trajPush("step/end", now, { turn: this._trajTurn, step: this._trajStep });
				break;
			case "agent_end":
				this._trajPush("turn/end", now, { turn: this._trajTurn, reason: { kind: "completed" } });
				break;
			case "message_start": {
				const m = e.message as AgentMessage;
				if ((m as { role?: string }).role === "user") {
					const c = (m as { content?: unknown }).content;
					this._trajPush("user/message", now, {
						turn: this._trajTurn,
						step: this._trajStep,
						content: this._trajContent(c),
						source: { kind: "user" },
					});
				}
				break;
			}
			case "message_update": {
				const m = e.message as AgentMessage;
				if ((m as { role?: string }).role !== "assistant") break;
				if (this._trajChunkSeen.has(this._trajStep)) break;
				this._trajChunkSeen.add(this._trajStep);
				this._trajPush("assistant/chunk", now, { turn: this._trajTurn, step: this._trajStep });
				break;
			}
			case "message_end": {
				const m = e.message as AgentMessage;
				const role = (m as { role?: string }).role;
				if (role === "assistant") {
					const a = m as AssistantMessage;
					this._trajPush("assistant/message", now, {
						turn: this._trajTurn,
						step: this._trajStep,
						message: { content: a.content },
						usage: a.usage,
					});
				}
				break;
			}
			case "tool_execution_start":
				this._trajToolCall(e.toolCallId, e.toolName, e.args, now);
				break;
			case "tool_execution_end": {
				const r = e.result as { content?: unknown } | undefined;
				this._trajPush("tool/result", now, {
					message: { source: { callId: e.toolCallId }, content: r?.content },
					error: e.isError ? {} : undefined,
				});
				break;
			}
			case "auto_retry_start": {
				if (this._trajRetryId === undefined) {
					this._trajRetry += 1;
					this._trajRetryId = `pi-retry-${this._trajRetry}`;
				}
				this._trajPush("llm/retry", now, {
					retryId: this._trajRetryId,
					turn: this._trajTurn,
					step: this._trajStep,
					retry: e.attempt,
					maxRetries: e.maxAttempts,
					delayMs: e.delayMs,
					failure: { message: e.errorMessage },
				});
				break;
			}
			case "auto_retry_end":
				if (this._trajRetryId !== undefined) {
					this._trajPush("llm/retry-started", now, { retryId: this._trajRetryId });
					this._trajRetryId = undefined;
				}
				break;
			case "compaction_start":
				this._trajPush("compaction/start", now, { reason: e.reason });
				break;
			case "compaction_end":
				this._trajPush("compaction/end", now, { reason: e.reason, removed: e.result?.tokensBefore });
				break;
			case "entry_appended": {
				const entry = e.entry as SessionEntry;
				if (entry.type === "model_change") {
					const m = entry as { provider?: string; modelId?: string };
					this._trajPush("request/header", Date.parse(entry.timestamp ?? "") || now, {
						reason: "change",
						header: { config: { provider: m.provider, model: m.modelId } },
					});
				}
				break;
			}
			default:
				break;
		}
	}

	private replayHistory(): void {
		try {
			const entries = this._session.sessionManager.buildContextEntries();
			const messages = entries.flatMap((entry) => sessionEntryToContextMessages(entry));
			for (const message of messages) this.projectMessage(message, { live: false });
		} catch {
			// History replay is best-effort; a malformed old entry must not block boot.
		}
	}

	/** Re-render the transcript from the session manager without rebinding —
	 *  used by /reload, where the AgentSession instance is kept. */
	private rebuildTranscript(): void {
		this.rowList.length = 0;
		this.toolRows.clear();
		this.groupStart = -1;
		this.groupRowIds = [];
		this.groupStreaming = false;
		this.replayHistory();
		this.emit();
	}

	private projectMessage(message: AgentMessage, ctx: { live: boolean }): void {
		switch (message.role) {
			case "user": {
				const text = contentText((message as { content?: unknown }).content);
				if (!text) return;
				this.rowList.push({ id: this.rowSeq++, kind: "user", text, time: (message as { timestamp?: number }).timestamp, fresh: ctx.live });
				break;
			}
			case "assistant": {
				this.projectAssistantBlocks(message as AssistantMessage, { live: false, streaming: false });
				break;
			}
			case "toolResult": {
				const tr = message as unknown as { toolCallId: string; toolName: string; content: { type: string; text?: string }[]; isError: boolean; details?: unknown };
				const row = this.toolRows.get(tr.toolCallId);
				if (row?.tool) {
					row.tool.status = tr.isError ? "error" : "ok";
					row.tool.resultText = contentText(tr.content);
					row.tool.resultView = this.resultView(tr.toolName, tr);
				}
				break;
			}
			case "bashExecution": {
				const b = message as { command: string; output: string; exitCode?: number; excludeFromContext?: boolean };
				this.rowList.push({ id: this.rowSeq++, kind: "local", text: `!${b.command}`, executionTarget: "local" });
				this.rowList.push({ id: this.rowSeq++, kind: "local-output", text: b.output || "(no output)" });
				break;
			}
			case "custom": {
				const c = message as { customType: string; content: unknown; display: boolean };
				if (c.display) {
					this.rowList.push({ id: this.rowSeq++, kind: "local", text: `[${c.customType}]` });
					const text = contentText(c.content);
					if (text) this.rowList.push({ id: this.rowSeq++, kind: "local-output", text });
				}
				break;
			}
			case "compactionSummary": {
				const c = message as { summary: string; tokensBefore?: number };
				this.rowList.push({ id: this.rowSeq++, kind: "compact", text: c.summary });
				break;
			}
			case "branchSummary": {
				const b = message as { summary: string };
				this.rowList.push({ id: this.rowSeq++, kind: "compact", text: b.summary });
				break;
			}
			default:
				break;
		}
	}

	private toolTitle(name: string, args: Record<string, unknown>): string {
		const p = typeof args.path === "string" ? args.path : undefined;
		switch (name) {
			case "bash":
			case "powershell":
				return typeof args.command === "string" ? args.command.split("\n")[0]! : name;
			case "read":
			case "write":
			case "edit":
				return p ?? name;
			case "grep":
				return typeof args.pattern === "string" ? `/${args.pattern}/` : name;
			case "find":
				return typeof args.pattern === "string" ? args.pattern : name;
			case "ls":
				return p ?? ".";
			default:
				return p ?? name;
		}
	}

	private callView(name: string, args: Record<string, unknown>): ToolCallView | undefined {
		const title = this.toolTitle(name, args);
		switch (name) {
			case "bash":
			case "powershell":
				return { card: "terminal", title, description: title, cwd: this.cwd };
			case "edit": {
				const edits = Array.isArray(args.edits) ? (args.edits as { oldText?: string; newText?: string }[]) : [];
				if (typeof args.path === "string" && edits.length > 0) {
					const diffs: ToolFileDiff[] = edits
						.filter((e) => typeof e.oldText === "string" || typeof e.newText === "string")
						.map((e) => ({ path: args.path as string, oldText: e.oldText ?? null, newText: e.newText ?? "" }));
					if (diffs.length > 0) return { card: "diff", title, diffs };
				}
				return { card: "generic", title, kind: name };
			}
			case "write": {
				if (typeof args.path === "string" && typeof args.content === "string") {
					return { card: "diff", title, diffs: [{ path: args.path, oldText: null, newText: args.content }] };
				}
				return { card: "generic", title, kind: name };
			}
			case "read":
				return { card: "generic", title, kind: "read" };
			default:
				return { card: "generic", title, kind: name };
		}
	}

	private resultView(name: string, result: { content?: { type: string; text?: string }[]; isError?: boolean; details?: unknown }): ToolResultView | undefined {
		const text = contentText(result.content);
		const details = asRecord(result.details);
		switch (name) {
			case "bash":
			case "powershell": {
				const exitCode = /exited with code (\d+)/.exec(text)?.[1];
				return {
					card: "terminal",
					output: text,
					...(exitCode !== undefined ? { exitCode: Number(exitCode) } : {}),
				};
			}
			case "read":
				return { card: "read", path: undefined, content: (result.content ?? []).map((c) => ({ type: c.type, text: c.text })) };
			case "edit":
			case "write": {
				if (typeof details?.diff === "string" || typeof details?.patch === "string") {
					// The diff card wants before/after texts; a rendered unified
					// patch still beats raw JSON, so fall back to a terminal card.
					return { card: "terminal", output: (details.diff as string) ?? (details.patch as string) };
				}
				return { card: "generic", content: [{ type: "text", text }] };
			}
			case "grep":
				return { card: "generic", content: [{ type: "text", text }] };
			default:
				return { card: "generic", content: [{ type: "text", text }] };
		}
	}

	private ensureToolRow(callId: string, name: string, args: Record<string, unknown>, insertAt: number): ChatRow {
		const existing = this.toolRows.get(callId);
		if (existing) return existing;
		const row: ChatRow = {
			id: this.rowSeq++,
			kind: "tool",
			text: "",
			fresh: true,
			tool: {
				callId,
				name,
				argsText: previewText(JSON.stringify(args), 400),
				argsFull: JSON.stringify(args, null, 2),
				status: "running",
				callView: this.callView(name, args),
				startedAt: Date.now(),
			},
		};
		this.toolRows.set(callId, row);
		const at = Math.min(Math.max(insertAt, 0), this.rowList.length);
		this.rowList.splice(at, 0, row);
		return row;
	}

	/** Re-project the live assistant message's content blocks into a row group. */
	private projectAssistantBlocks(message: AssistantMessage, ctx: { live: boolean; streaming: boolean }, activeIndex?: number): void {
		const content = message.content ?? [];
		if (this.groupStart === -1 || !ctx.live) {
			// History or first sight of this message: project wholesale, appended at end.
			const base = this.rowList.length;
			const ids: string[] = [];
			content.forEach((block, i) => {
				const insertAt = base + ids.length;
				if (block.type === "toolCall") {
					this.ensureToolRow((block as { id: string }).id, (block as { name: string }).name, ((block as { arguments?: unknown }).arguments ?? {}) as Record<string, unknown>, insertAt);
					ids.push("tool");
				} else if (block.type === "thinking") {
					const thinking = (block as { thinking?: string }).thinking ?? "";
					if (thinking) {
						this.rowList.splice(insertAt, 0, { id: this.rowSeq++, kind: "reasoning", text: thinking, streaming: ctx.streaming, fresh: ctx.live });
						ids.push("reasoning");
					} else {
						ids.push("skip");
					}
				} else if (block.type === "text") {
					const text = (block as { text?: string }).text ?? "";
					if (text || ctx.streaming) {
						this.rowList.splice(insertAt, 0, { id: this.rowSeq++, kind: "assistant", text, streaming: ctx.streaming, fresh: ctx.live, time: message.timestamp });
						ids.push("assistant");
					} else {
						ids.push("skip");
					}
				} else {
					ids.push("skip");
				}
			});
			if (ctx.live) {
				this.groupStart = base;
				this.groupRowIds = ids;
				this.groupStreaming = ctx.streaming;
				this.groupOpenedAt = Date.now();
			}
			return;
		}

		// Live update of the current group: rows sit at [groupStart, groupStart+count).
		const newRows: ChatRow[] = [];
		const newIds: string[] = [];
		content.forEach((block, i) => {
			const prevKind = this.groupRowIds[i];
			if (block.type === "toolCall") {
				const b = block as { id: string; name: string; arguments?: unknown };
				const args = (b.arguments ?? {}) as Record<string, unknown>;
				const row = this.ensureToolRowDetached(b.id, b.name, args);
				// `message_update` hands us the WHOLE partial message on every
				// delta, so re-serializing every tool call each token (the old
				// behavior) is pure waste — for a large write/edit payload it
				// dominated the streaming frame on slower machines. Only the
				// block this event actually targeted needs re-serializing; the
				// rest are already settled. History replay (activeIndex undefined)
				// still refreshes all of them once.
				if (row.tool && (activeIndex === undefined || activeIndex === i)) {
					const next = previewText(JSON.stringify(args), 400);
					if (next !== row.tool.argsText) row.tool = { ...row.tool, argsText: next };
				}
				newRows.push(row);
				newIds.push("tool");
				return;
			}
			const kind = block.type === "thinking" ? "reasoning" : block.type === "text" ? "assistant" : undefined;
			if (kind === undefined) return;
			const text = block.type === "thinking" ? ((block as { thinking?: string }).thinking ?? "") : ((block as { text?: string }).text ?? "");
			if (kind === "reasoning" && !text) return;
			if (kind === "assistant" && !text && !ctx.streaming) return;
			const reuse = prevKind === kind && i < newIds.length;
			newRows.push({
				id: reuse ? this.rowList[this.groupStart + newIds.length]!.id : this.rowSeq++,
				kind,
				text,
				streaming: ctx.streaming,
				fresh: true,
				time: message.timestamp,
			});
			newIds.push(kind);
		});
		this.rowList.splice(this.groupStart, this.groupRowIds.filter((k) => k !== "skip").length, ...newRows);
		this.groupRowIds = newIds;
		this.groupStreaming = ctx.streaming;
	}

	/** ensureToolRow variant used inside group projection (position assigned by splice). */
	private ensureToolRowDetached(callId: string, name: string, args: Record<string, unknown>): ChatRow {
		const existing = this.toolRows.get(callId);
		if (existing) {
			return existing;
		}
		const row: ChatRow = {
			id: this.rowSeq++,
			kind: "tool",
			text: "",
			fresh: true,
			tool: {
				callId,
				name,
				argsText: previewText(JSON.stringify(args), 400),
				argsFull: JSON.stringify(args, null, 2),
				status: "running",
				callView: this.callView(name, args),
				startedAt: Date.now(),
			},
		};
		this.toolRows.set(callId, row);
		return row;
	}

	private onSessionEvent(e: AgentSessionEvent): void {
		this._trajEvent(e);
		switch (e.type) {
			case "turn_start":
				this._working = true;
				this._turnStart = Date.now();
				this._responseChars = 0;
				this._activeToolCount = 0;
				this.emit();
				break;
			case "turn_end":
				this.emit();
				break;
			case "message_start": {
				const message = e.message as AgentMessage;
				if (message.role === "user") {
					this.projectMessage(message, { live: true });
					this._pending = this._pending.slice(1);
				} else if (message.role === "assistant") {
					this.groupStart = this.rowList.length;
					this.groupRowIds = [];
					this.groupStreaming = true;
					this.groupOpenedAt = Date.now();
				} else if (message.role === "custom" || message.role === "bashExecution" || message.role === "compactionSummary" || message.role === "branchSummary") {
					// bashExecution rows are produced by runLocalCommand; custom rows
					// arrive via entry_appended / display flags below.
					if (message.role !== "bashExecution") this.projectMessage(message, { live: true });
				}
				this.emit();
				break;
			}
			case "message_update": {
				const message = e.message as AssistantMessage;
				if (message.role !== "assistant") break;
				const ev = e.assistantMessageEvent as { type: string; delta?: string; partial?: AssistantMessage; contentIndex?: number };
				const partial = (ev.partial ?? message) as AssistantMessage;
				this.projectAssistantBlocks(partial, { live: true, streaming: true }, ev.contentIndex);
				if (ev.type === "text_delta" && typeof ev.delta === "string") {
					this._responseChars += ev.delta.length;
					const now = Date.now();
					this.tpsWindow.push({ t: now, chars: ev.delta.length });
					while (this.tpsWindow.length > 0 && now - this.tpsWindow[0]!.t > 3000) this.tpsWindow.shift();
					const span = Math.max(1, now - this.tpsWindow[0]!.t);
					const tps = (this.tpsWindow.reduce((a, b) => a + b.chars, 0) / span) * 1000;
					const last = this._tpsSamples.at(-1);
					if (!last || now - last.at > 500) this._tpsSamples.push({ tps, at: now });
					else last.tps = tps;
					if (this._tpsSamples.length > 60) this._tpsSamples.shift();
				}
				this.emitStream();
				break;
			}
			case "message_end": {
				const message = e.message as AgentMessage;
				if (message.role === "assistant") {
					const m = message as AssistantMessage;
					this.projectAssistantBlocks(m, { live: true, streaming: false });
					this.groupStreaming = false;
					this.groupStart = -1;
					this.groupRowIds = [];
					if (m.stopReason === "aborted") {
						this.rowList.push({ id: this.rowSeq++, kind: "interrupt", text: "Interrupted" });
					} else if (m.stopReason === "error") {
						this.rowList.push({ id: this.rowSeq++, kind: "notice", text: m.errorMessage ?? "Error" });
					}
					if (m.usage) {
						this._tokens.input += m.usage.input ?? 0;
						this._tokens.output += m.usage.output ?? 0;
						this._tokens.cacheRead += m.usage.cacheRead ?? 0;
						this._tokens.cacheWrite += m.usage.cacheWrite ?? 0;
						this._lastUsage = {
							input: m.usage.input ?? 0,
							output: m.usage.output ?? 0,
							cacheRead: m.usage.cacheRead ?? 0,
							cacheWrite: m.usage.cacheWrite ?? 0,
						};
					}
					this._sessionTitle = this._session.sessionName ?? this._sessionTitle;
				} else if (message.role === "user") {
					// already projected at message_start
				}
				this.emit();
				break;
			}
			case "tool_execution_start": {
				this._activeToolCount++;
				const row = this.toolRows.get(e.toolCallId);
				if (row?.tool) row.tool.status = "running";
				this.emit();
				break;
			}
			case "tool_execution_update": {
				const row = this.toolRows.get(e.toolCallId);
				if (row?.tool) {
					row.tool.resultText = contentText((e.partialResult as { content?: unknown })?.content);
				}
				this.emitStream();
				break;
			}
			case "tool_execution_end": {
				this._activeToolCount = Math.max(0, this._activeToolCount - 1);
				const result = e.result as { content?: { type: string; text?: string }[]; isError?: boolean; details?: unknown };
				const row = this.toolRows.get(e.toolCallId);
				if (row?.tool) {
					row.tool.status = e.isError ? "error" : "ok";
					row.tool.resultText = contentText(result?.content);
					row.tool.resultFull = row.tool.resultText;
					row.tool.resultView = this.resultView(e.toolName, result ?? {});
					row.tool.durationMs = Date.now() - row.tool.startedAt;
				}
				this.emit();
				break;
			}
			case "agent_end":
				this._working = false;
				this._activeToolCount = 0;
				this.groupStart = -1;
				this.groupRowIds = [];
				this.groupStreaming = false;
				this.emit();
				break;
			case "agent_settled":
				this._working = false;
				this._cancelPending = false;
				this.tpsWindow = [];
				this.emit();
				break;
			case "queue_update": {
				const items: PendingMessage[] = [
					...e.steering.map((t, i) => ({ id: `q-s-${i}`, text: t, images: [], placement: "steer" as const })),
					...e.followUp.map((t, i) => ({ id: `q-f-${i}`, text: t, images: [], placement: "followup" as const })),
				];
				this._pending = items;
				this.emit();
				break;
			}
			case "compaction_start":
				this._compaction = { startedAt: Date.now(), phase: "prefill", outputChars: 0, cancellable: true };
				this.emit();
				break;
			case "compaction_end":
				this._compaction = undefined;
				if (!e.aborted && e.result) this.scheduleRebuild();
				this.emit();
				break;
			case "auto_retry_start":
				this.notify(`Retry ${e.attempt}/${e.maxAttempts} in ${Math.round(e.delayMs / 1000)}s — ${e.errorMessage}`, { color: "warning", timeoutMs: Math.min(e.delayMs, 10000) });
				break;
			case "auto_retry_end":
				if (!e.success && e.finalError) this.notify(`Failed: ${e.finalError}`, { color: "error" });
				break;
			case "session_info_changed":
				this._sessionTitle = e.name ?? "";
				this.emit();
				break;
			case "thinking_level_changed":
				this.emit();
				break;
			case "entry_appended": {
				const entry = e.entry as SessionEntry;
				if (entry.type === "custom") {
					const c = entry as { customType: string; data?: unknown };
					this.rowList.push({ id: this.rowSeq++, kind: "notice", text: `[${c.customType}]` });
					this.emit();
				}
				break;
			}
			case "bash_execution_update": {
				if (this.bashOutputId !== -1) {
					const row = this.rowList.find((r) => r.id === this.bashOutputId);
					if (row) row.text += e.delta;
					this.emitStream();
				}
				break;
			}
			default:
				break;
		}
	}

	private scheduleRebuild(): void {
		if (this.rebuildTimer) return;
		this.rebuildTimer = setTimeout(() => {
			this.rebuildTimer = undefined;
			this.rowList.length = 0;
			this.toolRows.clear();
			this.groupStart = -1;
			this.groupRowIds = [];
			this.replayHistory();
			this.emit();
		}, 0);
	}

	/**
	 * Refresh the git branch without blocking the event loop.
	 *
	 * This used to run `execSync("git ...")`, which spawns a shell plus git and
	 * BLOCKS Node for its entire lifetime (~50–300ms on Windows). The Ink
	 * renderer and input handling share that event loop, so the poll surfaced
	 * as a periodic freeze every 5s — the classic "Windows feels laggy"
	 * symptom. `execFile` skips the shell (no cmd.exe on Windows) and the async
	 * form never stalls a frame. Overlapping polls are dropped, and
	 * `windowsHide` avoids a flashing console window for the child.
	 */
	private refreshGitBranch(): void {
		if (this.gitRefreshing) return;
		this.gitRefreshing = true;
		execFile(
			"git",
			["--no-optional-locks", "rev-parse", "--abbrev-ref", "HEAD"],
			{ cwd: this.cwd, timeout: 2000, windowsHide: true, encoding: "utf8" },
			(err, stdout) => {
				this.gitRefreshing = false;
				const next = err ? undefined : String(stdout).trim() || undefined;
				if (next !== this._gitBranch) {
					this._gitBranch = next;
					this.emit();
				}
			},
		);
	}

	// ─── prefs / history persistence ───────────────────────────────────

	private readPrefs(): ButterPrefs {
		try {
			return JSON.parse(readFileSync(this.prefsPath, "utf8")) as ButterPrefs;
		} catch {
			return {};
		}
	}

	private writePrefs(): void {
		try {
			mkdirSync(dirname(this.prefsPath), { recursive: true });
			writeFileSync(this.prefsPath, JSON.stringify(this.prefs, null, 2));
		} catch {}
	}

	private historyPath(): string {
		return join(this.agentDir(), "butterpi-history.json");
	}

	private loadHistory(): void {
		try {
			this.history = JSON.parse(readFileSync(this.historyPath(), "utf8")) as string[];
		} catch {
			this.history = [];
		}
	}

	private rememberHistory(text: string): void {
		if (!text.trim()) return;
		this.history.push(text);
		if (this.history.length > 1000) this.history.shift();
		try {
			mkdirSync(dirname(this.historyPath()), { recursive: true });
			writeFileSync(this.historyPath(), JSON.stringify(this.history));
		} catch {}
	}

	// ─── lifecycle ─────────────────────────────────────────────────────

	get session(): AgentSession {
		return this._session;
	}

	dispose(): void {
		if (this.gitTimer) clearInterval(this.gitTimer);
		this.unsubscribe?.();
		try {
			this._session.dispose();
		} catch {}
	}
}
