import React from 'react'
import { Box, Text } from '../ui.js'
import { renderCellRows } from './Whale.js'

/**
 * butterpi 的开屏立绘：一块立体黄油砖，正面压着 π 刻印。
 *
 * 与像素鲸鱼同一套渲染管线（真彩色 + 半块像素，见 `Whale.renderCellRows`）与
 * 布局契约（`WHALE_BOX_WIDTH` 定宽 40 列、30 行 sprite = 15 终端行），所以能直接
 * 顶替鲸鱼的槽位。区别是：字形不再靠手画 letter-grid，而是用一小段**程序化渲染**
 * ——按几何面求交再做明暗，边缘 3×3 超采样，得到平滑的渐变与立体感；静态立绘，
 * 不接开屏帧动画、闲置规划器和点击爱心。
 *
 * 投影（正交，光从左上前方来）：正面是一块矩形；深度向量 `(+DX, -DY)` 拉出顶面
 * 平行四边形与右侧面平行四边形；正面居中压一个 π 凹槽——凹槽底压暗、下沿挑亮，
 * 做出"压进去"的浮雕感。
 */

type Rgb = readonly [number, number, number]

/** Sprite 尺寸：40 列 × 30 行（半块渲染后 15 终端行，与文字列等高）。 */
const W = 40
const H = 30
/** 深度向量：从正面顶边/右边往"后"拉出的位移。 */
const DX = 7
const DY = 7
/** 正面矩形的范围（sprite 坐标，y 向下）。 */
const FX0 = 1
const FX1 = 31
const FY0 = 9
const FY1 = 26

/** 各面的起止色：顶面最亮、正面次之、右侧面最暗（光从左上前方来）。 */
const TOP_FRONT: Rgb = [255, 247, 190]
const TOP_BACK: Rgb = [247, 206, 96]
const FRONT_TOP: Rgb = [255, 216, 86]
const FRONT_BOT: Rgb = [226, 160, 26]
const RIGHT_FRONT: Rgb = [216, 158, 36]
const RIGHT_BACK: Rgb = [172, 114, 14]
const GLOSS: Rgb = [255, 253, 232]

const RIM_TOP: Rgb = [255, 250, 205]
const SHEEN: Rgb = [255, 240, 172]
const FRONT_SHADE: Rgb = [188, 126, 16]
const PI_DARK: Rgb = [181, 118, 15]
const PI_LIGHT: Rgb = [255, 230, 158]

/** π 刻印的几何（sprite 坐标）：顶横 + 两条腿，横比腿各外挑一格。 */
const PI_BAR_X0 = 9
const PI_BAR_X1 = 24
const PI_BAR_Y0 = 15
const PI_BAR_Y1 = 17
const PI_LEG_Y1 = 23

const mix = (a: Rgb, b: Rgb, t: number): Rgb => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
]

/** π 凹槽的形状判定（sprite 像素中心用）。 */
function piInside(x: number, y: number): boolean {
  if (y >= PI_BAR_Y0 && y < PI_BAR_Y1 && x >= PI_BAR_X0 && x <= PI_BAR_X1) return true
  if (y >= PI_BAR_Y1 && y < PI_LEG_Y1) {
    if (x >= PI_BAR_X0 + 1 && x <= PI_BAR_X0 + 3) return true
    if (x >= PI_BAR_X1 - 3 && x <= PI_BAR_X1 - 1) return true
  }
  return false
}

/**
 * 求某个连续坐标落在哪个面上，返回该点的颜色；不在立绘内返回 `undefined`。
 * 三个面按 顶面 → 正面 → 右侧面 依次测试，边界重叠无害。
 */
function faceColor(xc: number, yc: number): Rgb | undefined {
  // 顶面：按深度 u 从正面顶边线性插值（u=0 前、u=1 后）。
  const u = (FY0 - yc) / DY
  if (u >= 0 && u <= 1) {
    const xl = FX0 + DX * u
    const xr = FX1 + DX * u
    if (xc >= xl && xc <= xr) {
      let c = mix(TOP_FRONT, TOP_BACK, u)
      // 斜向高光带：从左前角往右后扫，越靠后越弱。
      const f = (xc - xl) / Math.max(1, xr - xl)
      c = mix(c, GLOSS, Math.exp(-Math.pow((f - (0.28 + 0.2 * u)) / 0.11, 2)) * 0.55 * (1 - u * 0.4))
      // 正面顶边那道亮棱：顶面折进正面时最亮的一线。
      c = mix(c, RIM_TOP, Math.exp(-Math.pow((yc - (FY0 - 1.4)) / 1.1, 2)) * 0.45)
      return c
    }
  }
  // 正面：竖直渐变 + 左侧柔光 + 顶部亮棱 + 底部压暗。
  if (xc >= FX0 && xc <= FX1 && yc >= FY0 && yc <= FY1) {
    const t = (yc - FY0) / (FY1 - FY0)
    let c = mix(FRONT_TOP, FRONT_BOT, t)
    c = mix(c, SHEEN, Math.exp(-Math.pow((xc - FX0 - 7) / 10, 2)) * 0.14)
    c = mix(c, RIM_TOP, Math.exp(-Math.pow((yc - (FY0 + 0.6)) / 0.9, 2)) * 0.5)
    c = mix(c, FRONT_SHADE, Math.max(0, (t - 0.78) / 0.22) * 0.35)
    return c
  }
  // 右侧面：沿深度渐暗。
  if (xc >= FX1 && xc <= FX1 + DX) {
    const u = (xc - FX1) / DX
    const yt = FY0 - DY * u
    const yb = FY1 - DY * u
    if (yc >= yt && yc <= yb) return mix(RIGHT_FRONT, RIGHT_BACK, u)
  }
  return undefined
}

/** 3×3 超采样：拿边缘覆盖率做反锯齿，覆盖率不足一半的像素留空。 */
const SS = 3
function pixel(x: number, y: number): Rgb | undefined {
  let r = 0
  let g = 0
  let b = 0
  let n = 0
  for (let sy = 0; sy < SS; sy++) {
    for (let sx = 0; sx < SS; sx++) {
      const c = faceColor(x + (sx + 0.5) / SS, y + (sy + 0.5) / SS)
      if (c !== undefined) {
        r += c[0]
        g += c[1]
        b += c[2]
        n++
      }
    }
  }
  if (n < SS * SS * 0.5) return undefined
  let c: Rgb = [r / n, g / n, b / n]
  // π 刻印按 sprite 像素落位（保证边缘干脆）：凹槽底压暗，下沿挑一道亮。
  const xc = x + 0.5
  const yc = y + 0.5
  if (xc > FX0 && xc < FX1 && yc > FY0 && yc < FY1) {
    const xi = Math.floor(xc)
    const yi = Math.floor(yc + 0.001)
    if (piInside(xi, yi)) c = piInside(xi, yi + 1) ? PI_DARK : PI_LIGHT
  }
  // SGR 只认整数字段：超采样出的通道值必须取整，否则整行颜色序列非法。
  return [Math.round(c[0]), Math.round(c[1]), Math.round(c[2])]
}

/** Pre-rendered ANSI rows, computed once at module load. */
const RENDERED: readonly string[] = renderCellRows(W, H, pixel)

/**
 * The static butter-π art: 15 rows × 40 columns, never shrinking. `width` pins
 * the box width so the neighbouring text column never shifts — same contract
 * as `WhaleArt`.
 */
export function ButterArt({ width }: { width?: number }): React.ReactNode {
  return (
    <Box flexDirection="column" flexShrink={0} width={width}>
      {RENDERED.map((row, index) => (
        <Text key={index} wrap="truncate-end">
          {row}
        </Text>
      ))}
    </Box>
  )
}
