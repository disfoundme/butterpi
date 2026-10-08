/**
 * Deep imports into @earendil-works/pi-coding-agent.
 *
 * The package's `exports` map only exposes "." and a couple of entry points,
 * but pi's own interactive TUI ships as library code we reuse at runtime via
 * absolute file-URL imports (which bypass the exports map). Types come from
 * the shipped .d.ts files through the same paths — TypeScript resolves them
 * because it ignores package exports for files that exist on disk when the
 * specifier fails. To keep tsc happy regardless, the loads are dynamic.
 */

import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

let pkgRoot: string | undefined;
async function codingAgentRoot(): Promise<string> {
	if (!pkgRoot) {
		// resolve.exports only maps "." — use ESM resolution, which honors it.
		const resolved = await import.meta.resolve("@earendil-works/pi-coding-agent");
		pkgRoot = dirname(fileURLToPath(resolved)) + "/..";
	}
	return pkgRoot;
}

export async function deepImport<T = any>(rel: string): Promise<T> {
	const abs = join(await codingAgentRoot(), rel);
	return (await import(pathToFileURL(abs).href)) as T;
}

export interface ThemeModule {
	theme: ThemeApi;
	initTheme(themeName?: string, enableWatcher?: boolean): void;
	setTheme(name: string, enableWatcher?: boolean): { success: boolean; error?: string };
	onThemeChange(cb: () => void): void;
	getAvailableThemes(): string[];
	getAvailableThemesWithPaths(): { name: string; path: string | undefined }[];
	getThemeByName(name: string): any;
	getDefaultTheme(): string;
	getMarkdownTheme(): any;
	getSelectListTheme(): any;
	getEditorTheme(): any;
	getSettingsListTheme(): any;
	highlightCode(code: string, lang: string): string[];
	getLanguageFromPath(path: string): string;
}

export interface ThemeApi {
	name?: string;
	fg(color: string, text: string): string;
	bg(color: string, text: string): string;
	bold(text: string): string;
	italic(text: string): string;
	underline(text: string): string;
	inverse(text: string): string;
	strikethrough(text: string): string;
	getThinkingBorderColor(level: string): (s: string) => string;
	getBashModeBorderColor(): (s: string) => string;
}

export interface RenderersModule {
	withBuiltInRenderers<T>(toolName: string, definition: T | undefined): T | undefined;
	createAllToolRenderers(): Record<string, unknown>;
}

export interface KeybindingsModule {
	KeybindingsManager: new (agentDir?: string) => any;
}

export interface FooterDataModule {
	FooterDataProvider: new (cwd: string) => FooterDataProviderApi;
}

export interface FooterDataProviderApi {
	getGitBranch(): string | null;
	getExtensionStatuses(): ReadonlyMap<string, string>;
	getAvailableProviderCount(): number;
	onBranchChange(cb: () => void): () => void;
	setExtensionStatus(key: string, text: string | undefined): void;
	setAvailableProviderCount(count: number): void;
	dispose(): void;
}

export interface MermaidModule {
	createMermaidMarkdownTransformer(options: Record<string, unknown>): any;
}

export interface CustomEntryModule {
	CustomEntryComponent: new (entry: unknown, renderer: unknown) => any;
}

export interface SessionSelectorsModule {
	TrustSelectorComponent: new (...args: any[]) => any;
}

let _theme: ThemeModule | undefined;
export async function themeModule(): Promise<ThemeModule> {
	if (!_theme) {
		_theme = await deepImport<ThemeModule>("dist/modes/interactive/theme/theme.js");
	}
	return _theme;
}

export function codingAgentDistPath(rel: string): Promise<string> {
	return codingAgentRoot().then((r) => join(r, rel));
}

/**
 * Import a module as resolved *from inside* pi-coding-agent's directory.
 * Needed for stateful singletons (pi-tui's global keybindings/theme) that pi's
 * components read from their own nested copy of the package.
 */
export async function importFromCodingAgent<T = any>(spec: string): Promise<T> {
	const req = createRequire(join(await codingAgentRoot(), "dist", "index.js"));
	const abs = req.resolve(spec);
	return (await import(pathToFileURL(abs).href)) as T;
}
