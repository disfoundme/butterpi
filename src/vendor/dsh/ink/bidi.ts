/**
 * Bidirectional text reordering for terminal rendering.
 *
 * Terminals on Windows do not implement the Unicode Bidi Algorithm,
 * so RTL text (Hebrew, Arabic, etc.) appears reversed. This module
 * applies the bidi algorithm to reorder ClusteredChar arrays from
 * logical order to visual order before Ink's LTR cell placement loop.
 *
 * On macOS terminals (Terminal.app, iTerm2) bidi works natively.
 * Windows Terminal (including WSL) does not implement bidi
 * (https://github.com/microsoft/terminal/issues/538).
 *
 * Detection: Windows Terminal sets WT_SESSION; native Windows cmd/conhost
 * also lacks bidi. We enable bidi reordering when running on Windows or
 * inside Windows Terminal (covers WSL).
 */
import bidiFactory from 'bidi-js'

type ClusteredChar = {
  value: string
  width: number
  styleId: number
  hyperlink: string | undefined
}

let bidiInstance: ReturnType<typeof bidiFactory> | undefined
let needsSoftwareBidi: boolean | undefined

function needsBidi(): boolean {
  if (needsSoftwareBidi === undefined) {
    needsSoftwareBidi =
      process.platform === 'win32' ||
      typeof process.env['WT_SESSION'] === 'string' || // WSL in Windows Terminal
      process.env['TERM_PROGRAM'] === 'vscode' // VS Code integrated terminal (xterm.js)
  }
  return needsSoftwareBidi
}

function getBidi() {
  if (!bidiInstance) {
    bidiInstance = bidiFactory()
  }
  return bidiInstance
}

/**
 * Reorder an array of ClusteredChars from logical order to visual order
 * using the Unicode Bidi Algorithm. Active on terminals that lack native
 * bidi support (Windows Terminal, conhost, WSL).
 *
 * Returns the same array on bidi-capable terminals (no-op).
 * @param characters - clustered chars in logical order.
 * @returns the characters in visual order, or the same array when no reordering applies.
 */
export function reorderBidi(characters: ClusteredChar[]): ClusteredChar[] {
  if (!needsBidi() || characters.length === 0) {
    return characters
  }

  // Fast RTL pre-scan over the clustered values. Windows (and WSL/VS Code)
  // run this for EVERY rendered line, so build no joined copy and run no
  // regex: the RTL scripts we reorder are all BMP, so a code-unit range
  // check is exact and allocates nothing. The joined string is only built
  // once RTL is actually present.
  let hasRtl = false
  for (let i = 0; i < characters.length; i++) {
    if (hasRTLCodeUnit(characters[i]!.value)) {
      hasRtl = true
      break
    }
  }
  if (!hasRtl) {
    return characters
  }

  const plainText = characters.map(c => c.value).join('')
  const bidi = getBidi()
  const { levels } = bidi.getEmbeddingLevels(plainText, 'auto')

  // Map bidi levels back to ClusteredChar indices.
  // Each ClusteredChar may be multiple code units in the joined string.
  const charLevels: number[] = []
  let offset = 0
  for (let i = 0; i < characters.length; i++) {
    charLevels.push(levels[offset]!)
    offset += characters[i]!.value.length
  }

  // Get reorder segments from bidi-js, but we need to work at the
  // ClusteredChar level, not the string level. We'll implement the
  // standard bidi reordering: find the max level, then for each level
  // from max down to 1, reverse all contiguous runs >= that level.
  const reordered = [...characters]
  const maxLevel = Math.max(...charLevels)

  for (let level = maxLevel; level >= 1; level--) {
    let i = 0
    while (i < reordered.length) {
      if (charLevels[i]! >= level) {
        // Find the end of this run
        let j = i + 1
        while (j < reordered.length && charLevels[j]! >= level) {
          j++
        }
        // Reverse the run in both arrays
        reverseRange(reordered, i, j - 1)
        reverseRangeNumbers(charLevels, i, j - 1)
        i = j
      } else {
        i++
      }
    }
  }

  return reordered
}

function reverseRange<T>(arr: T[], start: number, end: number): void {
  while (start < end) {
    const temp = arr[start]!
    arr[start] = arr[end]!
    arr[end] = temp
    start++
    end--
  }
}

function reverseRangeNumbers(arr: number[], start: number, end: number): void {
  while (start < end) {
    const temp = arr[start]!
    arr[start] = arr[end]!
    arr[end] = temp
    start++
    end--
  }
}

/**
 * True when `value` contains a code unit in an RTL block. Every script this
 * renderer reorders (Hebrew, Arabic, Syriac, Thaana, NKo, Samaritan, Mandaic)
 * is BMP, so a code-unit scan is exact and allocation-free — the hot path on
 * Windows, where terminals lack native bidi and every line is checked.
 */
function hasRTLCodeUnit(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i)
    // Exactly the original regex's ranges (no over-detection):
    // Hebrew, Arabic, Syriac and Thaana; Arabic Extended-A;
    // Arabic Presentation Forms-A and -B.
    if (c >= 0x0590 && c <= 0x07bf) return true
    if (c >= 0x08a0 && c <= 0x08ff) return true
    if (c >= 0xfb1d && c <= 0xfdff) return true
    if (c >= 0xfe70 && c <= 0xfeff) return true
  }
  return false
}
