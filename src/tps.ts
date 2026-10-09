/**
 * Live output tokens-per-second estimate.
 *
 * The streaming API only exposes characters (`text_delta`), not tokens, so a
 * live rate has to be estimated. Two bugs lived in the inline version this
 * replaces: the character rate was divided by the window span and labelled
 * "tok/s" — so it read ~4× too high — and a window that had just drained (the
 * first chunk of a response, or the first chunk after a pause) collapsed the
 * span to ~0ms and spiked the rate into the thousands. This keeps dsh's
 * ~4 chars/token ratio and refuses to report until the window holds a real
 * interval.
 */

/** Sliding window the estimate is averaged over. */
export const TPS_WINDOW_MS = 3000

/** Minimum span before a rate is trustworthy; below it a couple of characters
 *  over ~0ms is noise, not a rate. */
export const TPS_MIN_SPAN_MS = 250

/** Characters per token, used when real usage is unavailable (dsh's ratio). */
export const CHARS_PER_TOKEN = 4

/** One counted text delta in the window. */
export interface TpsCharSample {
	readonly t: number
	readonly chars: number
}

/**
 * Estimate tokens/s from a window of character deltas.
 * @param window - Samples ordered oldest-first, already trimmed to
 *   {@link TPS_WINDOW_MS}.
 * @param now - Current timestamp in ms.
 * @returns The estimate, or undefined when the window is too short to trust.
 */
export function estimateTps(window: readonly TpsCharSample[], now: number): number | undefined {
	if (window.length === 0) return undefined
	const span = now - window[0]!.t
	if (span < TPS_MIN_SPAN_MS) return undefined
	const chars = window.reduce((sum, sample) => sum + sample.chars, 0)
	return (chars / span) * 1000 / CHARS_PER_TOKEN
}
