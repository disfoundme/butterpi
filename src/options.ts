/** CLI options for butterpi — a small subset of pi's flags, plus butterpi-only ones. */

export interface ButterOptions {
	cwd: string;
	/** Resume a session: true = most recent for cwd; string = session file or id prefix */
	resume?: true | string;
	/** New session even if a resumable one exists */
	continueRecent: boolean;
	sessionDir?: string;
	agentDir?: string;
	model?: string;
	provider?: string;
	thinking?: string;
	models?: string[];
	tools?: string[];
	excludeTools?: string[];
	noTools?: boolean;
	noSession?: boolean;
	noExtensions?: boolean;
	noSkills?: boolean;
	noContextFiles?: boolean;
	systemPrompt?: string;
	appendSystemPrompt?: string;
	/** Suppress the frontend's own system-prompt capability notes (e.g. mermaid rendering). */
	noHarnessNotes?: boolean;
	extensionPaths: string[];
	themePaths: string[];
	skillPaths: string[];
	promptTemplatePaths: string[];
	/** Initial prompt(s) sent after startup */
	initialMessages: string[];
	help?: boolean;
	version?: boolean;
	/** Trusted cwd override like pi's --no-ask-style flags are handled via settings; keep simple */
	trust?: boolean;
	/** --theme: force the dsh-TUI theme (auto, dark, dark-ansi, light, or a custom name) */
	theme?: string;
	/** leftover args (forwarded to extensions' flag values unsupported; collected for errors) */
	extra: string[];
}

export function parseArgs(argv: string[]): ButterOptions {
	const opts: ButterOptions = {
		cwd: process.cwd(),
		continueRecent: false,
		extensionPaths: [],
		themePaths: [],
		skillPaths: [],
		promptTemplatePaths: [],
		initialMessages: [],
		extra: [],
	};

	const eatValue = (args: string[], i: number, flag: string): string => {
		const v = args[i + 1];
		if (v === undefined) throw new Error(`${flag} requires a value`);
		return v;
	};

	const args = argv.slice(2);
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		switch (true) {
			case a === "--help" || a === "-h":
				opts.help = true;
				break;
			case a === "--version" || a === "-V":
				opts.version = true;
				break;
			case a === "--resume" || a === "-r": {
				const v = args[i + 1];
				if (v !== undefined && !v.startsWith("-")) {
					opts.resume = v;
					i++;
				} else {
					opts.resume = true;
				}
				break;
			}
			case a === "--continue" || a === "-c":
				opts.continueRecent = true;
				break;
			case a === "--session-dir":
				opts.sessionDir = eatValue(args, i, a);
				i++;
				break;
			case a === "--agent-dir":
				opts.agentDir = eatValue(args, i, a);
				i++;
				break;
			case a === "--model" || a === "-m":
				opts.model = eatValue(args, i, a);
				i++;
				break;
			case a === "--provider" || a === "-p":
				opts.provider = eatValue(args, i, a);
				i++;
				break;
			case a === "--thinking" || a === "-t":
				opts.thinking = eatValue(args, i, a);
				i++;
				break;
			case a === "--models":
				opts.models = eatValue(args, i, a).split(",").map((s) => s.trim()).filter(Boolean);
				i++;
				break;
			case a === "--tools":
				opts.tools = eatValue(args, i, a).split(",").map((s) => s.trim()).filter(Boolean);
				i++;
				break;
			case a === "--exclude-tools":
				opts.excludeTools = eatValue(args, i, a).split(",").map((s) => s.trim()).filter(Boolean);
				i++;
				break;
			case a === "--no-tools":
				opts.noTools = true;
				break;
			case a === "--no-session":
				opts.noSession = true;
				break;
			case a === "--no-extensions":
				opts.noExtensions = true;
				break;
			case a === "--no-skills":
				opts.noSkills = true;
				break;
			case a === "--no-context-files":
				opts.noContextFiles = true;
				break;
			case a === "--system-prompt":
				opts.systemPrompt = eatValue(args, i, a);
				i++;
				break;
			case a === "--append-system-prompt":
				opts.appendSystemPrompt = eatValue(args, i, a);
				i++;
				break;
			case a === "--no-harness-notes":
				opts.noHarnessNotes = true;
				break;
			case a === "--extension" || a === "--extensions":
				opts.extensionPaths.push(...eatValue(args, i, a).split(","));
				i++;
				break;
			case a === "--theme" || a === "--themes":
				if (a === "--themes") {
					opts.themePaths.push(...eatValue(args, i, a).split(","));
					i++;
				} else {
					opts.theme = eatValue(args, i, a);
					i++;
				}
				break;
			case a === "--skills":
				opts.skillPaths.push(...eatValue(args, i, a).split(","));
				i++;
				break;
			case a === "--prompt-templates":
				opts.promptTemplatePaths.push(...eatValue(args, i, a).split(","));
				i++;
				break;
			case a === "--print":
				// Parsed on purpose so the error is explicit instead of the flag
				// silently swallowing a value and starting the TUI anyway.
				throw new Error("--print is not supported; butterpi is interactive-only — use `pi -p` for non-interactive runs");
			case a === "--trust":
				opts.trust = true;
				break;
			case a === "--no-update-check":
				// butterpi never phones home, so there is nothing to disable.
				// Reject explicitly rather than silently accepting a no-op.
				throw new Error("--no-update-check is not needed; butterpi performs no update checks");
			default:
				if (a.startsWith("-")) {
					opts.extra.push(a);
				} else {
					opts.initialMessages.push(a);
				}
		}
	}
	return opts;
}
