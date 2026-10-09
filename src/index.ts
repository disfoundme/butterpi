#!/usr/bin/env node
/**
 * butterpi — a fullscreen TUI frontend for the pi coding agent.
 * Inspired by dsh-TUI (ccch1mneyyy/dsh-TUI).
 */

// MUST stay first: aliases BUTTERPI_* onto DSH_TUI_* before the vendored
// renderer reads any environment variable (see src/env.ts).
import "./env.js";
import { VERSION } from "@earendil-works/pi-coding-agent";
import { parseArgs } from "./options.js";
import { createRuntime } from "./runtime.js";
import { startChatApp } from "./chat-app.js";

const HELP = `butterpi — fullscreen TUI for the pi coding agent

Usage: butterpi [options] [prompt...]

  -r, --resume [id|path]   Resume a session (picker if no arg)
  -c, --continue           Continue the most recent session for cwd
  -m, --model <spec>       Model, e.g. anthropic/claude-sonnet-4-5[:thinking]
  -p, --provider <name>    Provider for --model resolution
  -t, --thinking <level>   Thinking level
      --models <list>      Comma-separated model scope for cycling
      --tools <list>       Enable only these tools
      --exclude-tools <l>  Disable these tools
      --no-tools           Start with no tools
      --no-session         Don't persist the session
      --session-dir <dir>  Session storage directory
      --agent-dir <dir>    Config dir (default ~/.pi/agent)
      --extension <paths>  Extra extension files
      --skills <paths>     Extra skill dirs
      --prompt-templates <paths>
      --themes <paths>     Extra theme JSON files
      --theme <name>       Force theme: auto, dark, dark-ansi, light, or a
                           custom name (default: detect from background)
      --system-prompt <s>  Replace system prompt
      --append-system-prompt <s>
      --no-extensions/--no-skills/--no-context-files
      --trust              Trust this project's .pi resources
      --help, -h           Show help
      --version, -V        Version

In-app: Enter send · Esc interrupt · / commands · ! bash · @ files —
run /hotkeys in-app for the full shortcut list
`;

async function main() {
	let opts;
	try {
		opts = parseArgs(process.argv);
	} catch (err) {
		console.error(err instanceof Error ? err.message : String(err));
		process.exit(1);
	}
	if (opts.help) {
		console.log(HELP);
		process.exit(0);
	}
	if (opts.version) {
		console.log(`butterpi 0.1.0 · pi ${VERSION}`);
		process.exit(0);
	}
	if (opts.extra.length > 0) {
		console.error(`Unknown options: ${opts.extra.join(" ")}`);
		process.exit(1);
	}
	if (!process.stdin.isTTY || !process.stdout.isTTY) {
		console.error("butterpi requires a TTY. Use `pi -p` for non-interactive runs.");
		process.exit(1);
	}

	let rt;
	try {
		rt = await createRuntime(opts);
	} catch (err) {
		console.error(`Failed to start: ${err instanceof Error ? err.message : err}`);
		process.exit(1);
	}

	try {
		const app = await startChatApp(rt!, opts);
		await app.waitUntilExit();
	} catch (err) {
		console.error(`Startup failed: ${err instanceof Error ? err.message : err}`);
		process.exit(1);
	}
	process.exit(0);
}

await main();
