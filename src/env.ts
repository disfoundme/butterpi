/**
 * Environment precedence for butterpi.
 *
 * The vendored dsh-TUI rendering stack reads `DSH_TUI_*` / `DSH_HOME`. So that
 * butterpi can be configured without living in the DSH namespace, every
 * `BUTTERPI_*` variable is aliased onto the matching `DSH_TUI_*` name before any
 * vendored module reads it:
 *
 *   BUTTERPI_THEME=dark      -> DSH_TUI_THEME=dark
 *   BUTTERPI_LANG=en         -> DSH_TUI_LANG=en
 *   BUTTERPI_HOME=...        -> DSH_HOME=...
 *
 * A `BUTTERPI_*` value always wins; the `DSH_TUI_*` spelling is still honored
 * as a fallback. This module is imported for its side effect as the very first
 * import in `index.ts`, so it runs before the rest of the module graph.
 */

const TUI_PREFIX = "BUTTERPI_TUI_";
const GENERIC_PREFIX = "BUTTERPI_";

for (const [key, value] of Object.entries(process.env)) {
	if (value === undefined) continue;
	if (key.startsWith(TUI_PREFIX)) {
		process.env[`DSH_TUI_${key.slice(TUI_PREFIX.length)}`] = value;
	} else if (key.startsWith(GENERIC_PREFIX)) {
		process.env[`DSH_TUI_${key.slice(GENERIC_PREFIX.length)}`] = value;
	}
}

if (process.env.BUTTERPI_HOME) {
	process.env.DSH_HOME = process.env.BUTTERPI_HOME;
}
