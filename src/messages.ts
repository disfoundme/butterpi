/**
 * dsh-TUI-flavored message chrome on top of pi-tui primitives:
 *
 *   ButterUserMessage      — `❯ ` gold pointer + hanging-indent text, no
 *                            background box (dsh UserPromptMessage).
 *   ButterAssistantMessage — `● ` accent gutter marking the first content
 *                            line; thinking folds to a dim italic anchor
 *                            label, click to expand (dsh ⚓ Thinking row).
 *
 * Both keep pi's OSC 133 zone markers so terminals can track prompts.
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	Container,
	MouseRegion,
	Spacer,
	Text,
	type Component,
	type MarkdownOptions,
	type MarkdownTheme,
	type TuiMouseEvent,
} from "@earendil-works/pi-tui";
import { DshMarkdown, type DshUiTheme } from "./dsh-markdown.js";
import type { ThemeApi } from "./internals.js";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

/** pi's createMarkdownTransform(), reimplemented to avoid a deep import. */
function applyMarkdownTransformers(
	markdown: string,
	context: { messageType: string; isStreaming: boolean; availableWidth: number },
	transformers: Array<(md: string, ctx: unknown) => unknown>,
): string {
	let transformed = markdown;
	for (const transformer of transformers) {
		try {
			const out = transformer(transformed, context);
			if (typeof out === "string") transformed = out;
		} catch {
			// Keep the current markdown and continue.
		}
	}
	return transformed;
}

type MarkdownTransformer = (markdown: string, context: unknown) => unknown;
const noTransformers: MarkdownTransformer[] = [];

function dshOptions(
	messageType: string,
	isStreaming: boolean,
	transformers: MarkdownTransformer[] | undefined,
	extra?: MarkdownOptions,
): MarkdownOptions {
	return {
		...extra,
		transform: (md, width) =>
			applyMarkdownTransformers(md, { messageType, isStreaming, availableWidth: width }, transformers ?? noTransformers),
	};
}

/**
 * Assistant message: children render at `width - 2`, then the first
 * non-blank line gets `● ` and every other line `  ` (dsh layout).
 */
export class ButterAssistantMessage extends Container {
	private contentContainer = new Container();
	private hideThinkingBlock: boolean;
	private markdownTheme: MarkdownTheme;
	private uiTheme: ThemeApi;
	private hiddenThinkingLabel: string;
	private outputPad: number;
	private markdownTransformers?: MarkdownTransformer[];
	private lastMessage?: AssistantMessage;
	private hasToolCalls = false;
	private isStreaming = false;
	private thinkingVisibilityOverrides = new Map<number, boolean>();

	constructor(
		message: AssistantMessage | undefined,
		hideThinkingBlock: boolean,
		markdownTheme: MarkdownTheme,
		hiddenThinkingLabel: string,
		outputPad: number,
		uiTheme: ThemeApi,
		markdownTransformers?: MarkdownTransformer[],
	) {
		super();
		this.hideThinkingBlock = hideThinkingBlock;
		this.markdownTheme = markdownTheme;
		this.uiTheme = uiTheme;
		this.hiddenThinkingLabel = hiddenThinkingLabel;
		this.outputPad = outputPad;
		this.markdownTransformers = markdownTransformers;
		this.addChild(this.contentContainer);
		if (message) this.updateContent(message);
	}

	invalidate(): void {
		super.invalidate();
		if (this.lastMessage) this.updateContent(this.lastMessage);
	}

	setHideThinkingBlock(hide: boolean): void {
		this.hideThinkingBlock = hide;
		this.thinkingVisibilityOverrides.clear();
		if (this.lastMessage) this.updateContent(this.lastMessage);
	}

	setHiddenThinkingLabel(label: string): void {
		this.hiddenThinkingLabel = label;
		if (this.lastMessage) this.updateContent(this.lastMessage);
	}

	setOutputPad(padding: number): void {
		this.outputPad = padding;
		if (this.lastMessage) this.updateContent(this.lastMessage);
	}

	render(width: number): string[] {
		const inner = super.render(Math.max(1, width - 2));
		if (inner.length === 0) return inner;
		const bullet = this.uiTheme.fg("accent", "● ");
		const rest = "  ";
		let marked = false;
		const lines = inner.map((line) => {
			if (!marked && line.trim().length > 0) {
				marked = true;
				return bullet + line;
			}
			return rest + line;
		});
		if (this.hasToolCalls) return lines;
		lines[0] = OSC133_ZONE_START + lines[0];
		lines[lines.length - 1] = OSC133_ZONE_END + OSC133_ZONE_FINAL + lines[lines.length - 1];
		return lines;
	}

	handleMouse(event: TuiMouseEvent) {
		return super.handleMouse({ ...event, x: event.x - 2, width: Math.max(1, event.width - 2) });
	}

	updateContent(message: AssistantMessage, isStreaming: boolean = this.isStreaming): void {
		this.lastMessage = message;
		this.isStreaming = isStreaming;
		this.contentContainer.clear();

		const theme = this.uiTheme;
		const hasVisibleContent = message.content.some(
			(c) => (c.type === "text" && c.text.trim()) || (c.type === "thinking" && c.thinking.trim()),
		);
		if (hasVisibleContent) {
			this.contentContainer.addChild(new Spacer(1));
		}

		let thinkingRunIndex = 0;
		for (let i = 0; i < message.content.length; i++) {
			const content = message.content[i];
			if (content.type === "text" && content.text.trim()) {
				this.contentContainer.addChild(
					new DshMarkdown(
						content.text.trim(),
						this.outputPad,
						0,
						this.markdownTheme,
						undefined,
						dshOptions("assistant", this.isStreaming, this.markdownTransformers),
						theme,
					),
				);
			} else if (content.type === "thinking") {
				const thinkingBlocks: string[] = [];
				for (; i < message.content.length; i++) {
					const thinkingContent = message.content[i];
					if (thinkingContent.type !== "thinking") break;
					const thinking = thinkingContent.thinking.trim();
					if (thinking) thinkingBlocks.push(thinking);
				}
				i--;
				if (thinkingBlocks.length === 0) continue;
				const hasVisibleContentAfter = message.content
					.slice(i + 1)
					.some((c) => (c.type === "text" && c.text.trim()) || (c.type === "thinking" && c.thinking.trim()));
				const runIndex = thinkingRunIndex++;
				const hidden = this.thinkingVisibilityOverrides.get(runIndex) ?? this.hideThinkingBlock;
				const thinkingComponent: Component = hidden
					? new Text(theme.italic(theme.fg("thinkingText", this.hiddenThinkingLabel)), this.outputPad, 0)
					: new DshMarkdown(
							thinkingBlocks.join("\n\n"),
							this.outputPad,
							0,
							this.markdownTheme,
							{ color: (text) => theme.fg("thinkingText", text), italic: true },
							dshOptions("assistant-thinking", this.isStreaming, this.markdownTransformers),
							theme,
						);
				this.contentContainer.addChild(
					new MouseRegion(thinkingComponent, (event) => {
						if (event.type !== "click" || event.button !== "left") return undefined;
						this.thinkingVisibilityOverrides.set(runIndex, !hidden);
						if (this.lastMessage) this.updateContent(this.lastMessage);
						return { handled: true };
					}),
				);
				if (hasVisibleContentAfter) this.contentContainer.addChild(new Spacer(1));
			}
		}

		const hasToolCalls = message.content.some((c) => c.type === "toolCall");
		this.hasToolCalls = hasToolCalls;
		if (message.stopReason === "length") {
			this.contentContainer.addChild(new Spacer(1));
			this.contentContainer.addChild(
				new Text(theme.fg("error", "Response was truncated before completion."), this.outputPad, 0),
			);
		} else if (!hasToolCalls) {
			if (message.stopReason === "aborted") {
				const abortMessage =
					message.errorMessage && message.errorMessage !== "Request was aborted"
						? message.errorMessage
						: "Operation aborted";
				this.contentContainer.addChild(new Spacer(1));
				this.contentContainer.addChild(new Text(theme.fg("error", abortMessage), this.outputPad, 0));
			} else if (message.stopReason === "error") {
				const errorMsg = message.errorMessage || "Unknown error";
				this.contentContainer.addChild(new Spacer(1));
				this.contentContainer.addChild(new Text(theme.fg("error", `Error: ${errorMsg}`), this.outputPad, 0));
			}
		}
	}
}

/**
 * User message: `❯ text` in the gold pointer color with a hanging indent,
 * no background box (dsh UserPromptMessage).
 */
export class ButterUserMessage extends Container {
	private text: string;
	private markdownTheme: MarkdownTheme;
	private uiTheme: ThemeApi;
	private outputPad: number;
	private markdownTransformers?: MarkdownTransformer[];

	constructor(
		text: string,
		markdownTheme: MarkdownTheme,
		outputPad: number,
		uiTheme: ThemeApi,
		markdownTransformers?: MarkdownTransformer[],
	) {
		super();
		this.text = text;
		this.markdownTheme = markdownTheme;
		this.uiTheme = uiTheme;
		this.outputPad = outputPad;
		this.markdownTransformers = markdownTransformers;
		this.rebuild();
	}

	setOutputPad(padding: number): void {
		this.outputPad = padding;
		this.rebuild();
	}

	private rebuild(): void {
		this.clear();
		this.addChild(
			new DshMarkdown(
				this.text,
				0,
				0,
				this.markdownTheme,
				undefined,
				dshOptions("user", false, this.markdownTransformers, {
					preserveOrderedListMarkers: true,
					preserveBackslashEscapes: true,
				}),
				this.uiTheme,
			),
		);
	}

	render(width: number): string[] {
		const gutter = 2 + this.outputPad;
		const inner = super.render(Math.max(1, width - gutter));
		if (inner.length === 0) return inner;
		const pointer = this.uiTheme.bold(this.uiTheme.fg("mdHeading", "❯")) + " ";
		const rest = "  ";
		const pad = " ".repeat(this.outputPad);
		const lines = inner.map((line, i) => pad + (i === 0 ? pointer : rest) + line);
		lines[0] = OSC133_ZONE_START + lines[0];
		lines[lines.length - 1] = OSC133_ZONE_END + OSC133_ZONE_FINAL + lines[lines.length - 1];
		return lines;
	}
}
