/**
 * Working-activity indicator presets — the single source of truth for every
 * spinner animation, previously re-exported from the `dsh-working-activity`
 * npm package. butterpi vendors the data here so it takes **no dependency on
 * the DSH ecosystem**: the preset table is a verbatim copy of
 * `dsh-working-activity@0.5.1` `src/frames.ts` (BSD-3-Clause, © 2026 chimney);
 * see the repository-root `NOTICE.md`.
 *
 * The TUI keeps the original module path so existing importers (`/activity`
 * picker, status line, channel, activity prefs) resolve the same names.
 *
 * `\uFE0E` forces text rendering so Windows never paints the glyphs as color
 * emoji (the green-block problem); emoji presets (moon8, clock, whales)
 * deliberately omit it to keep colorful rendering on modern terminals.
 * @module dsh-tui/components/activityFrames
 */

/** Text-variant selector: keep symbols monochrome on Windows. */
const TE = '\uFE0E'

/** One working-activity preset: the frame sequence and the per-frame interval. */
export interface FramePreset {
  readonly frames: readonly string[]
  readonly intervalMs: number
}

/**
 * Every upstream preset (verbatim from dsh-working-activity `src/frames.ts`).
 * `claude` is filtered out of the public `FRAME_PRESETS` below.
 */
const UPSTREAM_PRESETS: Record<string, FramePreset> = {
  // Claude Code's real sequence: · ✢ * ✶ ✻ ✽ forward + backward.
  claude: {
    frames: ['·', `✢${TE}`, '*', `✶${TE}`, `✻${TE}`, `✽${TE}`, `✻${TE}`, `✶${TE}`, '*', `✢${TE}`],
    intervalMs: 150,
  },
  star2: { frames: [`✶${TE}`, `✸${TE}`, `✹${TE}`, `✺${TE}`, `✹${TE}`, `✷${TE}`], intervalMs: 140 },
  sand: {
    frames: ['⠁', '⠂', '⠄', '⡀', '⡈', '⡐', '⡠', '⣀', '⣁', '⣂', '⣄', '⣌', '⣔', '⣤', '⣥', '⣦', '⣮', '⣶', '⣷', '⣿', '⡿', '⠿', '⢟', '⠟', '⡛', '⠛', '⠫', '⢋', '⠋', '⠍', '⡉', '⠉', '⠑', '⠡', '⢁'],
    intervalMs: 120,
  },
  triangle: { frames: ['◢', '◣', '◤', '◥'], intervalMs: 180 },
  box: { frames: ['▖', '▘', '▝', '▗'], intervalMs: 180 },
  box2: { frames: ['▌', '▀', '▐', '▄'], intervalMs: 180 },
  corners: { frames: ['◰', '◳', '◲', '◱'], intervalMs: 190 },
  point: { frames: ['∙∙∙', '●∙∙', '∙●∙', '∙∙●', '∙∙∙'], intervalMs: 190 },
  layer: { frames: ['-', '=', '≡'], intervalMs: 220 },
  flip: { frames: ['_', '_', '_', '-', '`', '`', "'", '´', '-', '_', '_', '_'], intervalMs: 140 },
  aesthetic: {
    frames: ['▰▱▱▱▱▱▱', '▰▰▱▱▱▱▱', '▰▰▰▱▱▱▱', '▰▰▰▰▱▱▱', '▰▰▰▰▰▱▱', '▰▰▰▰▰▰▱', '▰▰▰▰▰▰▰', '▰▱▱▱▱▱▱'],
    intervalMs: 140,
  },
  hamburger: { frames: ['☱', '☲', '☴'], intervalMs: 220 },
  moon: { frames: ['◐', '◓', '◑', '◒'], intervalMs: 240 },
  // kimi-code MoonLoader 同款：8 帧 emoji 月相，120ms 一帧，比半圆版更丝滑。
  // 不带 \uFE0E：保留彩色 emoji 渲染（Windows Terminal 等现代终端效果最佳）。
  moon8: { frames: ['🌑', '🌒', '🌓', '🌔', '🌕', '🌖', '🌗', '🌘'], intervalMs: 120 },
  // 鲸鱼喷水：🐳 固定，水柱升起（· → | → ║）再回落，顶珠 ° 模拟水花（对齐 pi 版）。
  'whale-spout': {
    frames: ['🐳  ', '🐳° ', '🐳|°', '🐳║°', '🐳|°', '🐳° ', '🐳  '],
    intervalMs: 160,
  },
  // 鲸鱼转圈：🐳 + 环绕方向指示（逆时针转圈语义，对齐 pi 版）。
  'whale-spin': {
    frames: ['🐳→', '🐳↘', '🐳↓', '🐳↙', '🐳←', '🐳↖', '🐳↑', '🐳↗'],
    intervalMs: 150,
  },
  // 鲸鱼吐泡泡：🐳 固定，泡泡从头顶冒出（大泡 ○ 先行、小泡 ∘ 跟上）向右飘走。
  'whale-bubbles': {
    frames: ['🐳  ', '🐳○ ', '🐳 ○', '🐳  ', '🐳∘ ', '🐳 ∘', '🐳  '],
    intervalMs: 170,
  },
  // 时钟：12 个整点表盘循环（🕛 → 🕚），emoji 彩色渲染（同 moon8，不带 \uFE0E）。
  clock: {
    frames: ['🕛', '🕐', '🕑', '🕒', '🕓', '🕔', '🕕', '🕖', '🕗', '🕘', '🕙', '🕚'],
    intervalMs: 300,
  },
  // 红绿灯：🔴 → 🟡 → 🟢 循环，一轮 1.2s，节奏从容。
  traffic_lights: {
    frames: ['🔴', '🟡', '🟢'],
    intervalMs: 400,
  },
  comet: {
    frames: ['●    ', ' ●   ', '  ●  ', '   ● ', '    ●', '   ● ', '  ●  ', ' ●   '],
    intervalMs: 160,
  },
  breathe: { frames: ['▁', '▃', '▅', '▇', '▅', '▃'], intervalMs: 210 },
  dots: { frames: ['⣾', '⣷', '⣯', '⣟', '⡿', '⢿', '⣻', '⣽'], intervalMs: 140 },
  arrow: { frames: ['←', '↖', '↑', '↗', '→', '↘', '↓', '↙'], intervalMs: 160 },
  spark: { frames: ['·', '∘', '°', '✧', '°', '∘'], intervalMs: 240 },
  bar: { frames: ['▏', '▎', '▍', '▌', '▋', '▊', '▉', '█', '▉', '▊', '▋', '▌', '▍', '▎'], intervalMs: 120 },
  braille: { frames: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'], intervalMs: 120 },
  arc: { frames: ['◜', '◠', '◝', '◞', '◡', '◟'], intervalMs: 160 },
  circle: { frames: ['◴', '◷', '◶', '◵'], intervalMs: 190 },
  grow: { frames: ['.', 'o', 'O', '0', 'O', 'o'], intervalMs: 210 },
  noise: { frames: ['▓', '▒', '░', '▒'], intervalMs: 160 },
  bounce: { frames: ['⠁', '⠂', '⠄', '⡀', '⢀', '⠠', '⠐', '⠈'], intervalMs: 140 },
  rainbow: {
    frames: ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█', '▇', '▆', '▅', '▄', '▃', '▂'],
    intervalMs: 120,
  },
  // 双端进度条往返（pi 版独有，补全并集）。
  bar2: {
    frames: [
      '[    ]', '[=   ]', '[==  ]', '[=== ]', '[ ===]',
      '[  ==]', '[   =]', '[    ]', '[   =]', '[  ==]',
      '[ ===]', '[=== ]', '[==  ]', '[=   ]',
    ],
    intervalMs: 140,
  },
  dqpb: { frames: ['d', 'q', 'p', 'b'], intervalMs: 210 },
  toggle: { frames: ['⊶', '⊷'], intervalMs: 300 },
}

export const DEFAULT_PRESET = 'moon8'

/**
 * Read compatibility for saved preferences; the picker only offers current
 * names. `claude` is a pre-rename preset id: saved choices normalize to the
 * moon8 default instead of rendering the retired brand preset.
 */
export function normalizeActivityPreset(name: string | undefined): string | undefined {
  return name === 'claude' ? DEFAULT_PRESET : name
}

export const FRAME_PRESETS: Record<string, FramePreset> = Object.fromEntries(
  Object.entries(UPSTREAM_PRESETS).filter(([name]) => normalizeActivityPreset(name) === name),
)
export const PRESET_NAMES: readonly string[] = ['random', ...Object.keys(FRAME_PRESETS)]

export function isPresetName(name: string): boolean {
  const current = normalizeActivityPreset(name)!
  return current === 'random' || Object.hasOwn(FRAME_PRESETS, current)
}

export function resolvePreset(name: string | undefined): FramePreset {
  const current = normalizeActivityPreset(name)
  const names = Object.keys(FRAME_PRESETS)
  return FRAME_PRESETS[current === 'random' ? names[Math.floor(Math.random() * names.length)] : current ?? DEFAULT_PRESET]
    ?? FRAME_PRESETS[DEFAULT_PRESET]
}
