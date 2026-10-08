/** ButterStatusBar — one-line HUD rendered under the editor. */

import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { ThemeApi } from "./internals.js";

/** dsh dot spinner: [...[·,•,●,•], ...reversed] — a pulse, not a rotation. */
const SPINNER = ["·", "•", "●", "•", "•", "●", "•", "·"];

/** Random verb picked each time a turn starts (dsh-TUI spinnerVerbs.ts). */
const SPINNER_VERBS = [
	"Analyzing",
	"Thinking",
	"Working",
	"Considering",
	"Reviewing",
	"Planning",
	"Checking",
	"Reading",
	"Searching",
	"Building",
	"Testing",
	"Connecting",
	"Preparing",
	"Exploring",
	"Reasoning",
	"Summarizing",
	"Resolving",
	"Responding",
];

export interface StatusBarState {
	sessionName?: string;
	/** Explicit status text (retry, compacting, extension-set). Empty = pick a verb. */
	workingMessage: string;
	queueCount: number;
	tps: number;
	autoCompact: boolean;
	gitBranch: string | null;
	extensionStatuses: ReadonlyMap<string, string>;
}

export class StatusBar implements Component {
	private frame = 0;
	private timer?: ReturnType<typeof setInterval>;
	private wasBusy = false;
	private busySince = 0;
	private verb = "Working";
	state: StatusBarState = {
		workingMessage: "",
		queueCount: 0,
		tps: 0,
		autoCompact: true,
		gitBranch: null,
		extensionStatuses: new Map(),
	};

	constructor(
		private theme: ThemeApi,
		private getSession: () => AgentSession,
		private requestRender: () => void,
		private branding: string,
	) {}

	startTicker() {
		if (this.timer) return;
		this.timer = setInterval(() => {
			this.frame++;
			if (this.getSession().isStreaming || this.getSession().isCompacting || this.state.queueCount > 0) {
				this.requestRender();
			}
		}, 120);
	}

	stopTicker() {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const t = this.theme;
		const session = this.getSession();
		const s = this.state;

		const parts: string[] = [];

		const busy = session.isStreaming || session.isCompacting;
		if (busy && !this.wasBusy) {
			this.busySince = Date.now();
			this.verb = SPINNER_VERBS[Math.floor(Math.random() * SPINNER_VERBS.length)];
		}
		this.wasBusy = busy;

		if (busy) {
			const spin = SPINNER[this.frame % SPINNER.length];
			const label = s.workingMessage || `${this.verb}…`;
			const elapsed = Date.now() - this.busySince;
			const suffix = elapsed > 3000 ? t.fg("dim", ` (${Math.floor(elapsed / 1000)}s)`) : "";
			parts.push(t.fg("accent", spin) + " " + this.sweep(label) + suffix);
		} else {
			parts.push(t.fg("dim", "idle"));
		}

		const model = session.model;
		parts.push(
			t.fg("accent", t.bold(model ? `${model.provider}/${model.id}` : "no model")) +
				(session.supportsThinking() ? t.fg("dim", `:${session.thinkingLevel}`) : ""),
		);

		const usage = session.getContextUsage();
		if (usage && usage.tokens != null) {
			const pct = Math.max(0, Math.min(100, Math.round(usage.percent ?? 0)));
			const bar = this.gauge(pct / 100);
			const color = pct >= 85 ? "error" : pct >= 60 ? "warning" : "success";
			parts.push(t.fg(color, `${bar} ${pct}%`) + t.fg("dim", ` ${fmtTok(usage.tokens)}`));
		}

		if (s.tps > 0.5) parts.push(t.fg("muted", `${s.tps.toFixed(0)} tok/s`));

		const stats = session.getSessionStats();
		if (stats.tokens.total > 0) {
			parts.push(t.fg("dim", `Σ ${fmtTok(stats.tokens.total)}`));
			if (stats.cost > 0) parts.push(t.fg("dim", `$${stats.cost.toFixed(4)}`));
		}

		if (s.queueCount > 0) parts.push(t.fg("warning", `+${s.queueCount} queued`));
		if (s.gitBranch) parts.push(t.fg("muted", ` ${s.gitBranch}`));
		if (s.sessionName) parts.push(t.fg("dim", `«${s.sessionName}»`));

		for (const [, text] of s.extensionStatuses) {
			parts.push(t.fg("dim", text));
		}

		const brand = t.fg("dim", this.branding);
		const line = parts.join(t.fg("dim", " · "));
		const pad = Math.max(1, width - visibleWidth(line) - visibleWidth(brand) - 1);
		return [line + " ".repeat(pad) + brand];
	}

	private gauge(frac: number): string {
		const W = 8;
		const filled = Math.round(frac * W);
		return "[" + "█".repeat(filled) + "░".repeat(W - filled) + "]";
	}

	/**
	 * dsh shimmer sweep: a highlight window travels across the label.
	 * Window of 4 cells, full traverse + pause ~2.2s at the 120ms tick.
	 */
	private sweep(label: string): string {
		const t = this.theme;
		const len = [...label].length;
		if (len === 0) return "";
		const travel = len + 8;
		const pos = Math.floor(this.frame % travel) - 4;
		if (pos < 0 || pos > len) return t.fg("muted", label);
		const chars = [...label];
		let out = "";
		for (let i = 0; i < len; i++) {
			const inWindow = i >= pos && i < pos + 4;
			out += inWindow ? t.fg("accent", chars[i]) : t.fg("muted", chars[i]);
		}
		return out;
	}
}

export function fmtTok(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
	return `${n}`;
}
