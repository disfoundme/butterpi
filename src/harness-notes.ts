/**
 * Capability notes butterpi appends to the model's system prompt.
 *
 * Scoped to this frontend: they travel through the `appendSystemPrompt`
 * resource-loader option of the runtime butterpi creates, so the `pi` CLI and
 * its global configuration are never touched. A user's `--append-system-prompt`
 * still gets its spot alongside them; `--no-harness-notes` turns them off.
 */

/** What the transcript renders, told to the model so it actually uses it. */
export const BUTTERPI_HARNESS_NOTES = [
	"This terminal frontend (butterpi) renders GitHub-flavored Markdown, tables, LaTeX math written as $...$ or $$...$$, and Mermaid diagrams written as ```mermaid fenced blocks, which are drawn as Unicode box-drawing art.",
	"When a diagram clarifies structure or flow, prefer a ```mermaid block over ASCII art, and keep node labels short so the diagram fits the terminal width.",
].join(" ");

/**
 * The append-system-prompt list for pi's runtime: the user's own text first,
 * then this frontend's capability note unless disabled.
 * @param options - The parsed CLI options carrying the append text / opt-out.
 * @returns The list to hand to pi, or undefined when there is nothing to add.
 */
export function butterpiAppendSystemPrompt(options: {
	appendSystemPrompt?: string;
	noHarnessNotes?: boolean;
}): string[] | undefined {
	const parts: string[] = [];
	if (options.appendSystemPrompt) parts.push(options.appendSystemPrompt);
	if (options.noHarnessNotes !== true) parts.push(BUTTERPI_HARNESS_NOTES);
	return parts.length > 0 ? parts : undefined;
}
