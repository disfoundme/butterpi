/**
 * ButterEditor — pi's CustomEditor wrapped in a rounded box in the dsh-TUI
 * PromptInput style:
 *
 *   ╭───────────╮
 *   │❯ text     │
 *   │           │
 *   ╰───────────╯
 *
 * pi renders plain `─` top/bottom border lines and unpadded content. We render
 * the inner editor 5 columns narrower, wrap every line with the left gutter
 * (`│❯ ` on the first content row, `│  ` after) and right border ` │`, and
 * replace the border lines' edge dashes with `╭╮╰╯` corners — keeping pi's
 * embedded `↑/↓ N more` scroll indicators intact inside the border.
 */

import { CustomEditor } from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TuiMouseEvent, TUI } from "@earendil-works/pi-tui";
import type { ThemeApi } from "./internals.js";

/** Columns reserved around the inner editor: `│` + 2-col gutter + ` │`. */
const CHROME = 5;

interface EditorInternals {
	renderedVisibleLineCount: number;
	renderedAutocompleteHeight: number;
	borderColor: (s: string) => string;
}

export class ButterEditor extends CustomEditor {
	private uiTheme: ThemeApi;
	private isWorking?: () => boolean;

	constructor(
		tui: TUI,
		theme: EditorTheme,
		keybindings: any,
		options: any,
		uiTheme: ThemeApi,
		isWorking?: () => boolean,
	) {
		super(tui, theme, keybindings, options);
		this.uiTheme = uiTheme;
		this.isWorking = isWorking;
	}

	private internals(): EditorInternals {
		return this as unknown as EditorInternals;
	}

	render(width: number): string[] {
		const innerW = Math.max(1, width - CHROME);
		const inner = super.render(innerW);
		const internals = this.internals();
		const border = internals.borderColor;
		const n = Math.min(internals.renderedVisibleLineCount ?? 0, Math.max(0, inner.length - 2));
		const bottomIdx = 1 + n;
		const pointer = this.isWorking?.() ? this.uiTheme.fg("dim", "❯") : this.uiTheme.fg("accent", "❯");

		const out: string[] = [];
		for (let i = 0; i < inner.length; i++) {
			const line = inner[i];
			if (i === 0) {
				// ╭── + inner top border + ─╮  (inner keeps its scroll indicator)
				out.push(border("╭──") + line + border("─╮"));
			} else if (i === bottomIdx) {
				// ╰── + inner bottom border + ─╯
				out.push(border("╰──") + line + border("─╯"));
			} else if (i < bottomIdx) {
				const gutter = i === 1 ? `${pointer} ` : "  ";
				out.push(border("│") + gutter + line + border("│") + " ");
			} else {
				// Autocomplete rows hang below the box; align them with the text.
				out.push("   " + line);
			}
		}
		return out;
	}

	handleMouse(event: TuiMouseEvent) {
		// Shift coordinates back into inner-editor space (3-col left chrome).
		return super.handleMouse({ ...event, x: event.x - 3, width: Math.max(1, event.width - CHROME) });
	}
}
