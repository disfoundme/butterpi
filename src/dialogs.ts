/**
 * Modal dialogs on top of TuiAltScreen overlays: select / confirm / input / toast.
 * These back the ExtensionUIContext surface for pi extensions plus slash commands.
 */

import {
	Box,
	Container,
	Input,
	SelectList,
	Spacer,
	Text,
	type Component,
	type Focusable,
	type OverlayHandle,
	type TUI,
} from "@earendil-works/pi-tui";
import type { ThemeApi, ThemeModule } from "./internals.js";

function themedSelectListTheme(m: ThemeModule) {
	return m.getSelectListTheme();
}

function withBorder(theme: ThemeApi, title: string, child: Component): Component {
	const box = new Box(1, 0, (s) => theme.bg("selectedBg", s));
	box.addChild(new Text(theme.fg("accent", theme.bold(` ${title} `)), 0, 0));
	box.addChild(child);
	box.addChild(new Text(theme.fg("dim", " esc: cancel"), 0, 0));
	return box as unknown as Component;
}

class ModalList extends Container implements Focusable {
	focused = true;
	private list: SelectList;
	constructor(
		m: ThemeModule,
		title: string,
		options: string[],
		done: (v: string | undefined) => void,
	) {
		super();
		const items = options.map((o) => ({ value: o, label: o }));
		this.list = new SelectList(items, Math.min(14, items.length + 2), themedSelectListTheme(m));
		this.list.onSelect = (item) => done(item.value);
		this.list.onCancel = () => done(undefined);
		this.addChild(withBorder(m.theme, title, this.list));
	}
	handleInput(data: string): void {
		this.list.handleInput(data);
	}
}

class ModalConfirm extends Container implements Focusable {
	focused = true;
	constructor(theme: ThemeApi, title: string, message: string, done: (v: boolean) => void) {
		super();
		this.addChild(new Text(theme.fg("accent", theme.bold(` ${title} `)), 0, 0));
		this.addChild(new Text(message, 0, 0));
		this.addChild(new Text(theme.fg("dim", " y/n · esc: cancel"), 0, 0));
		this.done = done;
	}
	private done: (v: boolean) => void;
	private finished = false;
	handleInput(data: string): void {
		if (this.finished) return;
		if (data === "y" || data === "Y") {
			this.finished = true;
			this.done(true);
		} else if (data === "n" || data === "N" || data === "\x1b" || data === "\r") {
			this.finished = true;
			this.done(data === "\r" ? true : false);
		}
	}
}

class ModalInput extends Container implements Focusable {
	focused = true;
	private input: Input;
	constructor(theme: ThemeApi, title: string, placeholder: string | undefined, done: (v: string | undefined) => void) {
		super();
		this.input = new Input({ placeholder });
		this.input.onSubmit = (v) => done(v.trim() === "" ? undefined : v);
		this.input.onEscape = () => done(undefined);
		this.addChild(withBorder(theme, title, this.input));
	}
	handleInput(data: string): void {
		this.input.handleInput(data);
	}
}

export class Dialogs {
	constructor(
		private tui: TUI,
		private themeModule: ThemeModule,
	) {}

	private open(component: Component & Focusable, opts?: { width?: number | `${number}%`; maxHeight?: number | `${number}%` }): { handle: OverlayHandle; promise: Promise<unknown> } {
		const handle = this.tui.showOverlay(component, {
			width: opts?.width ?? "70%",
			minWidth: 30,
			maxHeight: opts?.maxHeight ?? "60%",
			anchor: "center",
		});
		handle.focus();
		return { handle, promise: Promise.resolve(undefined) };
	}

	select(title: string, options: string[]): Promise<string | undefined> {
		return new Promise((resolve) => {
			let handle: OverlayHandle | undefined;
			const modal = new ModalList(this.themeModule, title, options, (v) => {
				handle?.hide();
				resolve(v);
			});
			handle = this.tui.showOverlay(modal, { width: "60%", minWidth: 40, maxHeight: "60%" });
			handle.focus();
		});
	}

	confirm(title: string, message: string): Promise<boolean> {
		return new Promise((resolve) => {
			let handle: OverlayHandle | undefined;
			const modal = new ModalConfirm(this.themeModule.theme, title, message, (v) => {
				handle?.hide();
				resolve(v);
			});
			handle = this.tui.showOverlay(modal, { width: "60%", minWidth: 30, maxHeight: "50%" });
			handle.focus();
		});
	}

	input(title: string, placeholder?: string): Promise<string | undefined> {
		return new Promise((resolve) => {
			let handle: OverlayHandle | undefined;
			const modal = new ModalInput(this.themeModule.theme, title, placeholder, (v) => {
				handle?.hide();
				resolve(v);
			});
			handle = this.tui.showOverlay(modal, { width: "60%", minWidth: 40, maxHeight: 8 });
			handle.focus();
		});
	}

	/** Show arbitrary component modally with focus; returns a handle to hide it. */
	show(component: Component & Focusable, opts?: { width?: number | `${number}%`; maxHeight?: number | `${number}%` }): OverlayHandle {
		const handle = this.tui.showOverlay(component, {
			width: opts?.width ?? "80%",
			minWidth: 30,
			maxHeight: opts?.maxHeight ?? "80%",
		});
		handle.focus();
		return handle;
	}
}

/** Lightweight toast row placed above the status bar. */
export class ToastBar implements Component {
	private toasts: { text: string; kind: "info" | "warning" | "error"; until: number }[] = [];
	constructor(
		private theme: ThemeApi,
		private requestRender: () => void,
	) {}

	push(text: string, kind: "info" | "warning" | "error" = "info", ms = 4000) {
		this.toasts.push({ text, kind, until: Date.now() + ms });
		this.toasts = this.toasts.slice(-3);
		setTimeout(() => this.requestRender(), ms + 50);
		this.requestRender();
	}

	invalidate(): void {}

	render(width: number): string[] {
		const now = Date.now();
		this.toasts = this.toasts.filter((t) => t.until > now);
		const color = { info: "dim", warning: "warning", error: "error" } as const;
		return this.toasts.map((t) =>
			this.theme.fg(color[t.kind], " ▸ " + t.text.split("\n").join(" ").slice(0, width - 4)),
		);
	}
}
