/**
 * DshMarkdown — pi-tui's `Markdown` component re-dressed with dsh-TUI's
 * markdown conventions (spec: dsh-TUI src/terminal-utils/markdown.ts):
 *
 *   ▎ dim blockquote gutter (not │), italic quote text
 *   ```lang muted opening fence, no closing fence, 2-space code indent
 *   gold codespans (mdHeading), file-path codespans become file:// links
 *   headings: H1 bold+underline+accent, H2 bold+gold, H3+ bold — no `#`
 *   links: OSC8 label-only; mailto: rendered as plain text
 *   lists: gold `-` bullets; ordered markers 1. / a. / i. by nesting depth
 *   hr: literal `---`
 *   `~~x~~` stays literal (pi's tokenizer already restricts `~~`)
 *
 * pi's `Markdown` declares its internals `private` in the .d.ts although they
 * are plain runtime methods, so this subclass installs its overrides as
 * instance properties and reaches the originals through `MdInternals`.
 */

import {
	getCapabilities,
	hyperlink,
	Markdown,
	renderLatex,
	visibleWidth,
	wrapTextWithAnsi,
	type DefaultTextStyle,
	type MarkdownOptions,
	type MarkdownTheme,
} from "@earendil-works/pi-tui";
import { pathToFileURL } from "node:url";
import { isAbsolute, resolve } from "node:path";
import { homedir } from "node:os";

/** Left one-eighth block — dsh's blockquote gutter. */
const QUOTE_BAR = "▎";

/** Minimal slice of the app theme the renderer needs on top of MarkdownTheme. */
export interface DshUiTheme {
	fg(color: string, text: string): string;
}

interface InlineStyleContext {
	applyText: (text: string) => string;
	stylePrefix: string;
}

/** The runtime surface of pi's Markdown that the .d.ts hides behind `private`. */
interface MdInternals {
	theme: MarkdownTheme;
	options: MarkdownOptions & { transform?: (md: string, w: number) => string };
	paddingX: number;
	paddingY: number;
	getStylePrefix(styleFn: (text: string) => string): string;
	getDefaultInlineStyleContext(): InlineStyleContext;
	getOrderedListMarker(item: { raw: string }): string | undefined;
	getUnorderedListMarker(item: { raw: string }): string | undefined;
	renderToken(token: any, width: number, nextTokenType?: string, styleContext?: InlineStyleContext): string[];
	renderInlineTokens(tokens: any[], styleContext?: InlineStyleContext): string;
	renderList(token: any, depth: number, width: number, styleContext?: InlineStyleContext): string[];
}

/** Common code/config file extensions for the path-link heuristic. */
const FILE_EXT_RE =
	/\.(?:ts|tsx|js|jsx|mjs|cjs|py|rb|rs|go|java|kt|swift|c|h|cpp|hpp|cs|php|sh|bash|zsh|fish|sql|html|css|scss|json|jsonc|ya?ml|toml|xml|md|markdown|lua|pl|r|vim|graphql|proto|tf|hcl|vue|svelte|lock|txt|log|ini|cfg|conf|env|csv|makefile|dockerfile)$/i;

/** Light version of dsh's `looksLikeFilePath`. */
function looksLikeFilePath(text: string): boolean {
	if (!text || text.length > 300) return false;
	if (/[\s"`'\\]/.test(text)) return false;
	if (/^[a-z][a-z0-9+.-]*:/i.test(text)) return false; // URLs, mailto:, etc.
	return text.includes("/") || FILE_EXT_RE.test(text);
}

function fileUrlFor(path: string): string {
	let p = path;
	if (p === "~" || p.startsWith("~/")) p = homedir() + p.slice(1);
	const abs = isAbsolute(p) ? p : resolve(process.cwd(), p);
	return pathToFileURL(abs).href;
}

/** Ordered-list marker by nesting depth: 1. / a. / i. / decimal beyond. */
function formatListMarker(depth: number, ordinal: number): string {
	switch (depth) {
		case 2:
			return toAlphaIndex(ordinal);
		case 3:
			return toRomanNumeral(ordinal);
		default:
			return String(ordinal);
	}
}

/** Bijective base-26: 1 → a, 26 → z, 27 → aa. */
function toAlphaIndex(n: number): string {
	if (n <= 0) return "";
	return toAlphaIndex(Math.floor((n - 1) / 26)) + String.fromCharCode(97 + ((n - 1) % 26));
}

const ROMAN_SYMBOLS: ReadonlyArray<readonly [number, string]> = [
	[1000, "m"],
	[900, "cm"],
	[500, "d"],
	[400, "cd"],
	[100, "c"],
	[90, "xc"],
	[50, "l"],
	[40, "xl"],
	[10, "x"],
	[9, "ix"],
	[5, "v"],
	[4, "iv"],
	[1, "i"],
];

function toRomanNumeral(n: number): string {
	let out = "";
	for (const [value, glyph] of ROMAN_SYMBOLS) {
		while (n >= value) {
			out += glyph;
			n -= value;
		}
	}
	return out || String(n);
}

export class DshMarkdown extends Markdown {
	/** App theme for accent/gold paints that MarkdownTheme doesn't carry. */
	private uiTheme?: DshUiTheme;

	constructor(
		text: string,
		paddingX: number,
		paddingY: number,
		theme: MarkdownTheme,
		defaultTextStyle?: DefaultTextStyle,
		options?: MarkdownOptions,
		uiTheme?: DshUiTheme,
	) {
		super(text, paddingX, paddingY, theme, defaultTextStyle, options);
		this.uiTheme = uiTheme;
		const self = this as unknown as MdInternals & Record<string, unknown>;
		self.renderToken = (token: any, width: number, nextTokenType?: string, styleContext?: InlineStyleContext) =>
			this.dshRenderToken(token, width, nextTokenType, styleContext);
		self.renderList = (token: any, depth: number, width: number, styleContext?: InlineStyleContext) =>
			this.dshRenderList(token, depth, width, styleContext);
		self.renderInlineTokens = (tokens: any[], styleContext?: InlineStyleContext) =>
			this.dshRenderInlineTokens(tokens, styleContext);
	}

	private internals(): MdInternals {
		return this as unknown as MdInternals;
	}

	private callSuperRenderToken(
		token: any,
		width: number,
		nextTokenType?: string,
		styleContext?: InlineStyleContext,
	): string[] {
		return (Markdown.prototype as unknown as MdInternals).renderToken.call(
			this,
			token,
			width,
			nextTokenType,
			styleContext,
		);
	}

	/** Gold used for codespans / bullets / H2 — dsh's "permission" accent. */
	private gold(text: string): string {
		return this.uiTheme ? this.uiTheme.fg("mdHeading", text) : this.internals().theme.heading(text);
	}

	private accent(text: string): string {
		return this.uiTheme ? this.uiTheme.fg("accent", text) : this.internals().theme.heading(text);
	}

	// ------------------------------------------------------------------
	// Block-level tokens
	// ------------------------------------------------------------------

	private dshRenderToken(
		token: any,
		width: number,
		nextTokenType?: string,
		styleContext?: InlineStyleContext,
	): string[] {
		const internals = this.internals();
		const theme = internals.theme;
		const lines: string[] = [];
		switch (token.type) {
			case "heading": {
				// dsh: no `#` markers — H1 accent+bold+underline, H2 gold+bold, else bold.
				const depth = token.depth;
				const headingStyleFn =
					depth === 1
						? (text: string) => this.accent(theme.bold(theme.underline(text)))
						: depth === 2
							? (text: string) => this.gold(theme.bold(text))
							: (text: string) => theme.bold(text);
				const headingContext: InlineStyleContext = {
					applyText: headingStyleFn,
					stylePrefix: internals.getStylePrefix(headingStyleFn),
				};
				lines.push(this.dshRenderInlineTokens(token.tokens || [], headingContext));
				if (nextTokenType && nextTokenType !== "space") lines.push("");
				return lines;
			}
			case "code": {
				// dsh: muted ```lang opening line, no closing fence, 2-space indent.
				lines.push(theme.codeBlockBorder("```" + (token.lang || "")));
				const indent = theme.codeBlockIndent ?? "  ";
				const body = String(token.text ?? "").replace(/\n+$/, "");
				if (body === "") return lines;
				const bodyLines = theme.highlightCode
					? theme.highlightCode(body, token.lang)
					: body.split("\n").map((l) => theme.codeBlock(l));
				for (const hlLine of bodyLines) {
					lines.push(hlLine === "" ? hlLine : `${indent}${hlLine}`);
				}
				if (nextTokenType && nextTokenType !== "space") lines.push("");
				return lines;
			}
			case "blockquote": {
				// pi's quote flow, but with dsh's ▎ gutter instead of │.
				const quoteStyle = (text: string) => theme.quote(theme.italic(text));
				const quoteStylePrefix = internals.getStylePrefix(quoteStyle);
				const applyQuoteStyle = (line: string) => {
					if (!quoteStylePrefix) return quoteStyle(line);
					const lineWithReappliedStyle = line.replace(/\x1b\[0m/g, `\x1b[0m${quoteStylePrefix}`);
					return quoteStyle(lineWithReappliedStyle);
				};
				const quoteContentWidth = Math.max(1, width - 2);
				const quoteInlineStyleContext: InlineStyleContext = {
					applyText: (text) => text,
					stylePrefix: quoteStylePrefix,
				};
				const quoteTokens: any[] = token.tokens || [];
				const renderedQuoteLines: string[] = [];
				for (let i = 0; i < quoteTokens.length; i++) {
					renderedQuoteLines.push(
						...this.dshRenderToken(quoteTokens[i], quoteContentWidth, quoteTokens[i + 1]?.type, quoteInlineStyleContext),
					);
				}
				while (renderedQuoteLines.length > 0 && renderedQuoteLines[renderedQuoteLines.length - 1] === "") {
					renderedQuoteLines.pop();
				}
				for (const quoteLine of renderedQuoteLines) {
					const styledLine = applyQuoteStyle(quoteLine);
					for (const wrappedLine of wrapTextWithAnsi(styledLine, quoteContentWidth)) {
						lines.push(theme.quoteBorder(`${QUOTE_BAR} `) + wrappedLine);
					}
				}
				if (nextTokenType && nextTokenType !== "space") lines.push("");
				return lines;
			}
			case "hr": {
				// dsh renders a literal dashes rule.
				lines.push(theme.hr("---"));
				if (nextTokenType && nextTokenType !== "space") lines.push("");
				return lines;
			}
			default:
				return this.callSuperRenderToken(token, width, nextTokenType, styleContext);
		}
	}

	// ------------------------------------------------------------------
	// Lists — pi's structure with dsh's depth-aware ordered markers and
	// gold-tinted bullets (2-column hanging indent per level).
	// ------------------------------------------------------------------

	private dshRenderList(
		token: any,
		depth: number,
		width: number,
		styleContext?: InlineStyleContext,
	): string[] {
		const internals = this.internals();
		const lines: string[] = [];
		const indent = "  ".repeat(depth);
		const startNumber = typeof token.start === "number" ? token.start : 1;
		const tint = (s: string) => this.gold(s);
		for (let i = 0; i < token.items.length; i++) {
			const item = token.items[i];
			const isLastItem = i === token.items.length - 1;
			const bullet = token.ordered
				? internals.options.preserveOrderedListMarkers
					? (internals.getOrderedListMarker(item) ?? `${startNumber + i}. `)
					: `${formatListMarker(depth + 1, startNumber + i)}. `
				: internals.options.preserveOrderedListMarkers
					? (internals.getUnorderedListMarker(item) ?? "- ")
					: "- ";
			const taskMarker = item.task ? `[${item.checked ? "x" : " "}] ` : "";
			const marker = tint(bullet) + taskMarker;
			const firstPrefix = indent + marker;
			const continuationPrefix = indent + " ".repeat(visibleWidth(bullet) + taskMarker.length);
			const itemWidth = Math.max(1, width - visibleWidth(firstPrefix));
			let renderedAnyLine = false;
			for (const itemToken of item.tokens) {
				if (itemToken.type === "list") {
					lines.push(...this.dshRenderList(itemToken, depth + 1, width, styleContext));
					renderedAnyLine = true;
					continue;
				}
				const itemLines = this.dshRenderToken(itemToken, itemWidth, undefined, styleContext);
				for (const line of itemLines) {
					for (const wrappedLine of wrapTextWithAnsi(line, itemWidth)) {
						lines.push((renderedAnyLine ? continuationPrefix : firstPrefix) + wrappedLine);
						renderedAnyLine = true;
					}
				}
			}
			if (!renderedAnyLine) lines.push(firstPrefix);
			if (token.loose && !isLastItem) lines.push("");
		}
		return lines;
	}

	// ------------------------------------------------------------------
	// Inline tokens — pi's renderer with dsh's codespan/link/del behavior.
	// ------------------------------------------------------------------

	private dshRenderInlineTokens(tokens: any[], styleContext?: InlineStyleContext): string {
		const internals = this.internals();
		const theme = internals.theme;
		let result = "";
		const resolvedStyleContext = styleContext ?? internals.getDefaultInlineStyleContext();
		const { applyText, stylePrefix } = resolvedStyleContext;
		const applyTextWithNewlines = (text: string) =>
			text
				.split("\n")
				.map((segment) => applyText(segment))
				.join("\n");
		const paintCode = (text: string) => this.gold(text);
		for (const token of tokens) {
			switch (token.type) {
				case "latex": {
					const rendered =
						!token.pending && internals.options.renderLatex !== false
							? (renderLatex(token.text) ?? token.raw)
							: token.raw;
					result += applyTextWithNewlines(rendered);
					break;
				}
				case "escape":
					result += applyTextWithNewlines(
						internals.options.preserveBackslashEscapes ? token.raw : token.text,
					);
					break;
				case "text":
					if (token.tokens && token.tokens.length > 0) {
						result += this.dshRenderInlineTokens(token.tokens, resolvedStyleContext);
					} else {
						result += applyTextWithNewlines(token.text);
					}
					break;
				case "paragraph":
					result += this.dshRenderInlineTokens(token.tokens || [], resolvedStyleContext);
					break;
				case "strong": {
					const boldContent = this.dshRenderInlineTokens(token.tokens || [], resolvedStyleContext);
					result += theme.bold(boldContent) + stylePrefix;
					break;
				}
				case "em": {
					const italicContent = this.dshRenderInlineTokens(token.tokens || [], resolvedStyleContext);
					result += theme.italic(italicContent) + stylePrefix;
					break;
				}
				case "codespan": {
					const painted = paintCode(token.text);
					if (looksLikeFilePath(token.text) && getCapabilities().hyperlinks) {
						result += hyperlink(painted, fileUrlFor(token.text)) + stylePrefix;
					} else {
						result += painted + stylePrefix;
					}
					break;
				}
				case "link": {
					// dsh: mailto: collapses to the bare address.
					if (typeof token.href === "string" && token.href.startsWith("mailto:")) {
						result += applyTextWithNewlines(token.href.slice("mailto:".length)) + stylePrefix;
						break;
					}
					const linkText = this.dshRenderInlineTokens(token.tokens || [], resolvedStyleContext);
					// Label text is shown as-is when it differs from the URL; when the
					// label IS the URL (autolinks), rendering linkText yields the URL.
					const styledLink = theme.link(theme.underline(linkText || token.href));
					if (getCapabilities().hyperlinks) {
						result += hyperlink(styledLink, token.href) + stylePrefix;
					} else {
						// dsh's fallback shows just the label/URL text, colored.
						result += styledLink + stylePrefix;
					}
					break;
				}
				case "image":
					result += applyTextWithNewlines(typeof token.href === "string" ? token.href : token.text ?? "");
					break;
				case "br":
					result += "\n";
					break;
				case "del":
					// Strikethrough is disabled in dsh — render the source literally.
					result += applyTextWithNewlines(typeof token.raw === "string" ? token.raw : token.text) + stylePrefix;
					break;
				case "html":
					if ("raw" in token && typeof token.raw === "string") {
						result += applyTextWithNewlines(token.raw);
					}
					break;
				default:
					if ("text" in token && typeof token.text === "string") {
						result += applyTextWithNewlines(token.text);
					}
			}
		}
		while (stylePrefix && result.endsWith(stylePrefix)) {
			result = result.slice(0, -stylePrefix.length);
		}
		return result;
	}
}
