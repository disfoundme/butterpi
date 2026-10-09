/**
 * chat-app — boots the vendored dsh-TUI Chat screen on the vendored Ink
 * renderer, with PiChannel as the ChannelUi backend (pi's AgentSession).
 *
 * Layout mirrors dsh-TUI's own mount (dsh-adapter/plugin.ts):
 *   ThemeProvider > AlternateScreen > PageMargin > Chat
 */

import React from "react";
import { render, ThemeProvider, AlternateScreen } from "./vendor/dsh/ui.js";
import { Chat } from "./vendor/dsh/screens/Chat.js";
import { PageMargin } from "./vendor/dsh/components/PageMargin.js";
import { QuestionStore } from "./vendor/dsh/dsh-adapter/questions.js";
import { TuiDialogStore } from "./vendor/dsh/dsh-adapter/dialogs.js";
import { TuiStatusStore } from "./vendor/dsh/dsh-adapter/status.js";
import { ActivityStore } from "./vendor/dsh/dsh-adapter/activity-store.js";
import type { PromptController } from "./vendor/dsh/components/PromptInput.js";
import type { ChannelUi } from "./vendor/dsh/adapter/channel/ui-policy.js";
import { applyPageMargin } from "./vendor/dsh/tuiDisplayPrefs.js";
import type { AgentSession, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { PiChannel } from "./pi-channel.js";
import { themeModule } from "./internals.js";
import type { ButterOptions } from "./options.js";
import type { ButterRuntime } from "./runtime.js";

/**
 * Bridge pi's ExtensionUIContext onto the dsh-TUI stores: select/confirm/
 * input go through the managed dialog queue, notifications through the
 * channel, status lines through TuiStatusStore. Component-factory surfaces
 * (custom/footer/header/widget/editor) are pi-tui-shaped and cannot render
 * inside the Ink tree, so they degrade to no-ops with a one-time notice.
 */
function createExtensionUIContext(
	channel: PiChannel,
	dialogs: TuiDialogStore,
	status: TuiStatusStore,
	promptRef: React.RefObject<PromptController | null>,
): ExtensionUIContext {
	let warnedComponentUi = false;
	const warnComponentUi = () => {
		if (warnedComponentUi) return;
		warnedComponentUi = true;
		channel.notify("This extension uses pi-tui components, which the dsh-TUI frontend cannot render", { color: "warning" });
	};
	const piTheme = () => themeModule();
	let toolsExpanded = false;
	let editorFactory: unknown;
	const ctx = {
		select: (title: string, options: string[], opts?: { signal?: AbortSignal; timeout?: number }) =>
			dialogs
				.ask(
					{ kind: "select", title, options: options.map((o) => ({ id: o, label: o })) },
					opts?.signal,
					opts?.timeout,
				)
				.then((v) => (typeof v === "string" ? v : undefined)),
		confirm: (title: string, message: string, opts?: { signal?: AbortSignal; timeout?: number }) =>
			dialogs
				.ask({ kind: "confirm", title, message, confirmLabel: "Yes", cancelLabel: "No" }, opts?.signal, opts?.timeout)
				.then((v) => v === true),
		input: (title: string, placeholder?: string, opts?: { signal?: AbortSignal; timeout?: number }) =>
			dialogs
				.ask({ kind: "input", title, placeholder, initial: "" }, opts?.signal, opts?.timeout)
				.then((v) => (typeof v === "string" ? v : undefined)),
		notify: (message: string, type?: "info" | "warning" | "error") =>
			channel.notify(message, type === "error" ? { color: "error" } : type === "warning" ? { color: "warning" } : undefined),
		onTerminalInput: (handler: (data: string) => void) => {
			const wrapped = (data: Buffer) => handler(data.toString());
			process.stdin.on("data", wrapped);
			return () => {
				process.stdin.off("data", wrapped);
			};
		},
		setStatus: (key: string, text: string | undefined) => status.set(key, text),
		setWorkingMessage: (message?: string) => status.set("working", message),
		setWorkingVisible: () => {},
		setWorkingIndicator: () => {},
		setHiddenThinkingLabel: () => {},
		setWidget: (key: string, content: unknown) => {
			if (content !== undefined && content !== null) warnComponentUi();
		},
		setFooter: () => {},
		setHeader: () => {},
		setTitle: (title: string) => {
			try {
				process.stdout.write(`\x1b]0;${title}\x07`);
			} catch {}
		},
		custom: async () => {
			warnComponentUi();
			return undefined;
		},
		pasteToEditor: (text: string) => promptRef.current?.append(text),
		setEditorText: (text: string) => {
			const c = promptRef.current;
			if (!c) return;
			c.clear();
			if (text) c.append(text);
		},
		getEditorText: () => promptRef.current?.text() ?? "",
		editor: async (title: string, prefill?: string) =>
			dialogs
				.ask({ kind: "input", title, initial: prefill ?? "" })
				.then((v) => (typeof v === "string" ? v : undefined)),
		addAutocompleteProvider: () => {},
		setEditorComponent: (factory: unknown) => {
			editorFactory = factory;
			if (factory !== undefined) warnComponentUi();
		},
		getEditorComponent: () => editorFactory,
		get theme() {
			return undefined as never;
		},
		getAllThemes: () => {
			let list: { name: string; path: string | undefined }[] = [];
			void piTheme().then((tm) => {
				list = tm.getAvailableThemesWithPaths();
			});
			return list;
		},
		getTheme: () => undefined,
		setTheme: () => ({ success: false, error: "pi themes are not active under the dsh-TUI renderer" }),
		getToolsExpanded: () => toolsExpanded,
		setToolsExpanded: (v: boolean) => {
			toolsExpanded = v;
		},
	};
	return ctx as unknown as ExtensionUIContext;
}

export interface ChatApp {
	channel: PiChannel;
	waitUntilExit(): Promise<void>;
	shutdown(): void;
}

export async function startChatApp(rt: ButterRuntime, opts: ButterOptions): Promise<ChatApp> {
	const channel = new PiChannel(rt, opts);
	const questionStore = new QuestionStore();
	const extensionDialogs = new TuiDialogStore();
	const extensionStatus = new TuiStatusStore();
	const activityStore = new ActivityStore();
	const promptControllerRef = React.createRef<PromptController | null>();

	const uiContext = createExtensionUIContext(channel, extensionDialogs, extensionStatus, promptControllerRef);
	const bindExtensions = (session: AgentSession) =>
		session.bindExtensions({
			uiContext,
			mode: "tui",
			abortHandler: () => {
				const q = session.clearQueue();
				const restored = [...q.steering, ...q.followUp].join("\n");
				if (restored) promptControllerRef.current?.append(restored);
			},
			commandContextActions: {
				waitForIdle: () => session.waitForIdle(),
				newSession: (o) => rt.runtime.newSession(o).catch(() => ({ cancelled: true })),
				fork: (entryId, o) =>
					rt.runtime.fork(entryId, o).then(
						(r) => ({ cancelled: r.cancelled }),
						() => ({ cancelled: true }),
					),
				navigateTree: (targetId, o) => session.navigateTree(targetId, o).then((r) => ({ cancelled: r.cancelled }), () => ({ cancelled: true })),
				switchSession: (p, o) =>
					rt.runtime.switchSession(p, o).then(
						(r) => ({ cancelled: r.cancelled }),
						() => ({ cancelled: true }),
					),
				reload: async () => {
					await session.reload();
				},
			},
			onError: (err) =>
				channel.notify(`Extension error: ${(err as { error?: unknown })?.error ?? err}`, { color: "error" }),
		});
	channel.setExtensionBinder(bindExtensions);
	channel.setDialogStore(extensionDialogs);
	await bindExtensions(channel.session);

	applyPageMargin(channel.pageMargin);

	let instance: Awaited<ReturnType<typeof render>> | undefined;
	let exited = false;
	const shutdown = () => {
		if (exited) return;
		exited = true;
		try {
			instance?.unmount();
		} catch {}
	};

	const chat = React.createElement(Chat, {
		channel: channel as unknown as ChannelUi,
		questionStore,
		extensionDialogs,
		extensionStatus,
		activityStore,
		promptControllerRef,
		fullscreen: true,
		onExit: shutdown,
		starPrompt: null,
		openHomeOnBoot: false,
	});
	const tree = React.createElement(ThemeProvider, {
		// --theme forces the dsh-TUI theme (highest priority in ThemeProvider's
		// chain: prop > BUTTERPI_THEME/DSH_TUI_THEME env > persisted /theme >
		// OSC 11 background detection). Unknown names warn and fall back to
		// detection instead of failing boot.
		theme: opts.theme,
		children: React.createElement(AlternateScreen, null, React.createElement(PageMargin, null, chat)),
	});
	instance = await render(tree, { exitOnCtrlC: false });

	for (const d of rt.diagnostics) {
		channel.notify(`${d.type}: ${d.message}`, { color: d.type === "error" ? "error" : "warning" });
	}
	if (rt.modelFallbackMessage) channel.notify(rt.modelFallbackMessage, { color: "warning" });
	if (opts.initialMessages.length > 0) {
		channel.submit(opts.initialMessages.join(" "));
	}

	process.on("SIGTERM", shutdown);
	process.on("SIGHUP", shutdown);

	return {
		channel,
		shutdown,
		waitUntilExit: async () => {
			await instance!.waitUntilExit();
			channel.dispose();
			await rt.runtime.dispose().catch(() => {});
		},
	};
}
