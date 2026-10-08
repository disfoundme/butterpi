/**
 * Transcript — owns the chat document and translates session events /
 * persisted entries into pi's battle-tested message components.
 * Mirrors pi's own interactive-mode rendering contract.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type {
	AgentSession,
	AgentSessionEvent,
	SessionEntry,
} from "@earendil-works/pi-coding-agent";
import {
	BashExecutionComponent,
	BranchSummaryMessageComponent,
	CompactionSummaryMessageComponent,
	CustomMessageComponent,
	parseSkillBlock,
	sessionEntryToContextMessages,
	SkillInvocationMessageComponent,
	ToolExecutionComponent,
} from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text, type Component, type TUI } from "@earendil-works/pi-tui";
import type { ThemeModule } from "./internals.js";
import { ButterAssistantMessage, ButterUserMessage } from "./messages.js";

type AnyComponent = Component & { invalidate(): void };

export interface TranscriptDeps {
	tui: TUI;
	themeModule: ThemeModule;
	getSession: () => AgentSession;
	requestRender: () => void;
	/** Tool output expanded by default (Ctrl+O toggles) */
	getToolExpanded: () => boolean;
	setToolExpanded: (v: boolean) => void;
	hideThinking: boolean;
	hiddenThinkingLabel: string;
	outputPad: number;
	/** Optional deep-imported CustomEntryComponent for extension entries */
	customEntryComponent?: new (entry: unknown, renderer: unknown) => any;
}

export class Transcript {
	readonly container = new Container();
	private deps: TranscriptDeps;
	private streamingComponent?: ButterAssistantMessage;
	private streamingMessage?: AssistantMessage;
	private pendingTools = new Map<string, ToolExecutionComponent>();
	/** Entry ids mapped to their top-level components for the timeline */
	readonly turnAnchors: { label: string; component: Component }[] = [];

	constructor(deps: TranscriptDeps) {
		this.deps = deps;
	}

	private mdTheme() {
		return this.deps.themeModule.getMarkdownTheme();
	}

	private toolDef(toolName: string, renderers?: { withBuiltInRenderers: (n: string, d: any) => any }) {
		const def = this.deps.getSession().getToolDefinition(toolName);
		return renderers ? renderers.withBuiltInRenderers(toolName, def) : def;
	}

	private toolComponent(toolName: string, toolCallId: string, args: unknown, renderers?: { withBuiltInRenderers: (n: string, d: any) => any }) {
		const sm = this.deps.getSession().settingsManager;
		const c = new ToolExecutionComponent(
			toolName,
			toolCallId,
			args,
			{
				showImages: sm.getShowImages?.() ?? false,
				imageWidthCells: sm.getImageWidthCells?.(),
			},
			this.toolDef(toolName, renderers) as never,
			this.deps.tui,
			this.deps.getSession().sessionManager.getCwd(),
		);
		c.setExpanded(this.deps.getToolExpanded());
		return c;
	}

	private get session() {
		return this.deps.getSession();
	}

	/** Render a finished/historical message. */
	addMessage(message: AgentMessage, opts?: { populateHistory?: boolean }) {
		const chat = this.container;
		switch (message.role) {
			case "bashExecution": {
				const c = new BashExecutionComponent(message.command, this.deps.tui, message.excludeFromContext);
				if (message.output) c.appendOutput(message.output);
				c.setComplete(
					message.exitCode,
					message.cancelled,
					message.truncated ? (undefined as never) : undefined,
					message.fullOutputPath,
				);
				chat.addChild(c);
				break;
			}
			case "custom": {
				if (message.display) {
					const renderer = this.session.extensionRunner?.getMessageRenderer?.(message.customType);
					const c = new CustomMessageComponent(message, renderer, this.mdTheme(), this.deps.outputPad);
					c.setExpanded(this.deps.getToolExpanded());
					chat.addChild(c);
				}
				break;
			}
			case "compactionSummary": {
				chat.addChild(new Spacer(1));
				const c = new CompactionSummaryMessageComponent(message, this.mdTheme());
				c.setExpanded(this.deps.getToolExpanded());
				chat.addChild(c);
				break;
			}
			case "branchSummary": {
				chat.addChild(new Spacer(1));
				const c = new BranchSummaryMessageComponent(message, this.mdTheme());
				c.setExpanded(this.deps.getToolExpanded());
				chat.addChild(c);
				break;
			}
			case "system":
				break;
			case "user": {
				const text = this.getUserMessageText(message);
				if (text) {
					if (chat.children.length > 0) chat.addChild(new Spacer(1));
					const skillBlock = parseSkillBlock(text);
					if (skillBlock) {
						const c = new SkillInvocationMessageComponent(skillBlock, this.mdTheme());
						c.setExpanded(this.deps.getToolExpanded());
						chat.addChild(c);
						if (skillBlock.userMessage) {
							chat.addChild(new Spacer(1));
							chat.addChild(
								new ButterUserMessage(
									skillBlock.userMessage,
									this.mdTheme(),
									this.deps.outputPad,
									this.deps.themeModule.theme,
								),
							);
						}
					} else {
						const uc = new ButterUserMessage(
							text,
							this.mdTheme(),
							this.deps.outputPad,
							this.deps.themeModule.theme,
						);
						chat.addChild(uc);
					}
					this.turnAnchors.push({
						label: text.split("\n")[0].slice(0, 60),
						component: chat.children[chat.children.length - 1],
					});
				}
				break;
			}
			case "assistant": {
				chat.addChild(
					new ButterAssistantMessage(
						message,
						this.deps.hideThinking,
						this.mdTheme(),
						this.deps.hiddenThinkingLabel,
						this.deps.outputPad,
						this.deps.themeModule.theme,
					),
				);
				break;
			}
			case "toolResult":
				break;
			default:
				break;
		}
	}

	private getUserMessageText(message: AgentMessage): string {
		if (message.role !== "user") return "";
		const content = (message as { content?: unknown }).content;
		const blocks =
			typeof content === "string"
				? [{ type: "text", text: content }]
				: Array.isArray(content)
					? (content as Array<{ type: string; text?: string }>).filter((c) => c.type === "text")
					: [];
		return blocks.map((c) => c.text ?? "").join("");
	}

	/** Rebuild the whole transcript from a list of session entries (entries → messages). */
	renderSessionEntries(entries: SessionEntry[], renderers?: { withBuiltInRenderers: (n: string, d: any) => any }, opts?: { populateHistory?: boolean }) {
		this.pendingTools.clear();
		this.turnAnchors.length = 0;
		const renderedPendingTools = new Map<string, ToolExecutionComponent>();
		const items = entries.flatMap((entry) => sessionEntryToContextMessages(entry));
		for (const message of items) {
			if (message.role === "assistant") {
				this.addMessage(message);
				for (const content of message.content) {
					if (content.type === "toolCall") {
						const component = this.toolComponent(content.name, content.id, content.arguments, renderers);
						this.container.addChild(component);
						if (message.stopReason === "aborted" || message.stopReason === "error") {
							const errorMessage =
								message.stopReason === "aborted"
									? "Operation aborted"
									: (message.errorMessage ?? "Error");
							component.updateResult({ content: [{ type: "text", text: errorMessage }], isError: true });
						} else {
							renderedPendingTools.set(content.id, component);
						}
					}
				}
			} else if (message.role === "toolResult") {
				const component = renderedPendingTools.get(message.toolCallId);
				if (component) {
					component.updateResult(message as never);
					renderedPendingTools.delete(message.toolCallId);
				}
			} else {
				this.addMessage(message, opts);
			}
		}
		for (const [toolCallId, component] of renderedPendingTools) {
			this.pendingTools.set(toolCallId, component);
		}
		this.deps.requestRender();
	}

	rebuildFromSession(renderers?: { withBuiltInRenderers: (n: string, d: any) => any }) {
		this.container.clear();
		const entries = this.session.sessionManager.buildContextEntries();
		this.renderSessionEntries(entries, renderers);
	}

	/** Feed a live session event. Returns true if it affected the transcript. */
	handleEvent(event: AgentSessionEvent, renderers?: { withBuiltInRenderers: (n: string, d: any) => any }): void {
		const chat = this.container;
		switch (event.type) {
			case "message_start":
				if (event.message.role === "custom" || event.message.role === "user") {
					this.addMessage(event.message);
				} else if (event.message.role === "assistant") {
					this.streamingComponent = new ButterAssistantMessage(
						undefined,
						this.deps.hideThinking,
						this.mdTheme(),
						this.deps.hiddenThinkingLabel,
						this.deps.outputPad,
						this.deps.themeModule.theme,
					);
					this.streamingMessage = event.message;
					chat.addChild(this.streamingComponent);
					this.streamingComponent.updateContent(this.streamingMessage, true);
				}
				this.deps.requestRender();
				break;
			case "message_update":
				if (this.streamingComponent && event.message.role === "assistant") {
					this.streamingMessage = event.message;
					this.streamingComponent.updateContent(this.streamingMessage, true);
					for (const content of this.streamingMessage.content) {
						if (content.type === "toolCall") {
							if (!this.pendingTools.has(content.id)) {
								const component = this.toolComponent(content.name, content.id, content.arguments, renderers);
								chat.addChild(component);
								this.pendingTools.set(content.id, component);
							} else {
								this.pendingTools.get(content.id)!.updateArgs(content.arguments);
							}
						}
					}
					this.deps.requestRender();
				}
				break;
			case "message_end": {
				if (event.message.role === "user") break;
				if (this.streamingComponent && event.message.role === "assistant") {
					this.streamingMessage = event.message;
					if (this.streamingMessage.stopReason === "aborted") {
						this.streamingMessage.errorMessage = "Operation aborted";
					}
					this.streamingComponent.updateContent(this.streamingMessage, false);
					if (this.streamingMessage.stopReason === "aborted" || this.streamingMessage.stopReason === "error") {
						const errorMessage = this.streamingMessage.errorMessage ?? "Error";
						for (const [, component] of this.pendingTools.entries()) {
							component.updateResult({ content: [{ type: "text", text: errorMessage }], isError: true });
						}
						this.pendingTools.clear();
					} else {
						for (const [, component] of this.pendingTools.entries()) {
							component.setArgsComplete();
						}
					}
					this.streamingComponent = undefined;
					this.streamingMessage = undefined;
				}
				this.deps.requestRender();
				break;
			}
			case "tool_execution_start": {
				let component = this.pendingTools.get(event.toolCallId);
				if (!component) {
					component = this.toolComponent(event.toolName, event.toolCallId, event.args, renderers);
					chat.addChild(component);
					this.pendingTools.set(event.toolCallId, component);
				}
				component.markExecutionStarted();
				this.deps.requestRender();
				break;
			}
			case "tool_execution_update": {
				const component = this.pendingTools.get(event.toolCallId);
				if (component) {
					component.updateResult({ ...(event.partialResult as object), isError: false } as never, true);
					this.deps.requestRender();
				}
				break;
			}
			case "tool_execution_end": {
				const component = this.pendingTools.get(event.toolCallId);
				if (component) {
					component.updateResult({ ...(event.result as object), isError: event.isError } as never);
					this.pendingTools.delete(event.toolCallId);
					this.deps.requestRender();
				}
				break;
			}
			case "agent_end":
				if (this.streamingComponent) {
					chat.removeChild(this.streamingComponent);
					this.streamingComponent = undefined;
					this.streamingMessage = undefined;
				}
				this.pendingTools.clear();
				this.deps.requestRender();
				break;
			default:
				break;
		}
	}

	hideThinkingUpdate(hide: boolean) {
		this.deps.hideThinking = hide;
	}

	setToolExpandedAll(expanded: boolean) {
		this.deps.setToolExpanded(expanded);
		const walk = (c: Component) => {
			const anyC = c as { setExpanded?: (v: boolean) => void; children?: Component[] };
			anyC.setExpanded?.(expanded);
			anyC.children?.forEach(walk);
		};
		for (const child of this.container.children) walk(child);
		this.deps.requestRender();
	}

	clear() {
		this.container.clear();
		this.streamingComponent = undefined;
		this.streamingMessage = undefined;
		this.pendingTools.clear();
		this.turnAnchors.length = 0;
	}
}

/** Small helper: boxed info text used for statuses/errors. */
export function infoLine(theme: ThemeModule, text: string, color = "dim"): AnyComponent {
	return new Text(theme.theme.fg(color, text), 0, 0);
}
