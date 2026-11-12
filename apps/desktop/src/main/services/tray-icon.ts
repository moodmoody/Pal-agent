import { nativeImage, type NativeImage } from 'electron'
import { deflateSync } from 'zlib'

/**
 * 应用 / 托盘图标（运行期生成，无需任何二进制资产文件）。
 *
 * 遵「免装铁律」：只用内置 `zlib` 手写最小 PNG（RGBA 真彩 + alpha），
 * 画 Pal 标志（「!」作 D 的竖笔 + 半圆），与安装包图标 build/icon.ico 保持一致。
 * - 应用图标：32×32 逻辑像素彩色 PNG（附 2x）；Windows / Linux 托盘也用它（Windows 自动缩放到 16px）。
 * - macOS 菜单栏：另生成只有「!D」字形的单色模板图（见 `getTrayIcon`），由系统按菜单栏深浅着色。
 * 全程纯 JS、零第三方依赖，dev 与打包行为一致（不经 electron-vite `?asset` 资产管线，
 * 免去二进制资产的类型声明与打包路径问题）。
 */

// ── 最小 PNG 编码器（IHDR + IDAT + IEND，手写 CRC32）─────────────────────────

/** CRC32 查表（PNG 分块校验；不依赖 Node22 的 `zlib.crc32`，手写以兼容更低版本）。 */
const CRC_TABLE = ((): Uint32Array => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([len, body, crc])
}

/** 把 RGBA 像素缓冲编码为 PNG（每行前置 filter 字节 0，zlib 压缩 IDAT）。 */
function encodePng(width: number, height: number, rgba: Uint8Array): Buffer {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // 位深 8
  ihdr[9] = 6 // 颜色类型 6 = RGBA
  // 10/11/12 = 压缩 / 滤波 / 隔行，均 0

  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0 // filter: none
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1)
  }
  const idat = deflateSync(raw)
  return Buffer.concat([
    sig,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0))
  ])
}

// ── 绘制 Pal 标志（与 build/icon.svg、scripts/gen-icon.mjs 同一几何）──────────

type RGB = [number, number, number]

const BG_R = 224 // 底板圆角（1024 画布坐标）
const C0: RGB = [0x0f, 0x76, 0x6e] // 渐变起点 teal-700
const C1: RGB = [0x1e, 0x40, 0xaf] // 渐变终点 blue-800

/** 点是否在圆角方形底板内（1024 画布坐标）。 */
function inBg(x: number, y: number): boolean {
  const cx = Math.min(Math.max(x, BG_R), 1024 - BG_R)
  const cy = Math.min(Math.max(y, BG_R), 1024 - BG_R)
  return (x - cx) ** 2 + (y - cy) ** 2 <= BG_R * BG_R
}

/** 点到线段的距离平方。 */
function segDist2(px: number, py: number, x1: number, y1: number, x2: number, y2: number): number {
  const dx = x2 - x1
  const dy = y2 - y1
  const len2 = dx * dx + dy * dy
  let t = len2 === 0 ? 0 : ((px - x1) * dx + (py - y1) * dy) / len2
  t = Math.min(1, Math.max(0, t))
  const cx = x1 + t * dx
  const cy = y1 + t * dy
  return (px - cx) ** 2 + (py - cy) ** 2
}

// 「P」的骨架（1024 画布，与 scripts/gen-icon.mjs 一致）：
//   竖笔 x=342，y 250→790；碗 圆心(400,455) 中线半径 190 线宽 172，只取右半
const P_STEM: [number, number, number, number] = [342, 250, 342, 790]
const P_BOWL_CX = 400
const P_BOWL_CY = 455
const P_BOWL_R = 190
const P_W = 86 // 笔画半宽 → 线宽 172
const P_BOWL_IN = P_BOWL_R - P_W
const P_BOWL_OUT = P_BOWL_R + P_W

/** 点是否在白色「P」字形内。 */
function inShape(x: number, y: number): boolean {
  const w2 = P_W * P_W
  if (segDist2(x, y, ...P_STEM) <= w2) return true
  if (x >= P_BOWL_CX) {
    const d = Math.hypot(x - P_BOWL_CX, y - P_BOWL_CY)
    if (d >= P_BOWL_IN && d <= P_BOWL_OUT) return true
  }
  return false
}

/**
 * 生成标志 RGBA 像素：渐变圆角底板 + 白色「P」。
 * 按解析几何做 ss×ss 超采样抗锯齿，小尺寸（托盘 16/32px）边缘也不发毛。
 */
function drawLogo(size: number, ss = 8): Uint8Array {
  const px = new Uint8Array(size * size * 4)
  const k = 1024 / size
  const n = ss * ss
  for (let py = 0; py < size; py++) {
    for (let pxl = 0; pxl < size; pxl++) {
      let bgCov = 0
      let inkCov = 0
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const x = (pxl + (sx + 0.5) / ss) * k
          const y = (py + (sy + 0.5) / ss) * k
          if (inBg(x, y)) {
            bgCov++
            if (inShape(x, y)) inkCov++
          }
        }
      }
      if (!bgCov) continue
      const t = (pxl + py + 1) / (2 * size) // 左上 → 右下对角渐变
      const a = inkCov / bgCov
      const i = (py * size + pxl) * 4
      for (let c = 0; c < 3; c++) {
        const bg = C0[c] + (C1[c] - C0[c]) * t
        px[i + c] = Math.round(bg * (1 - a) + 255 * a)
      }
      px[i + 3] = Math.round((bgCov / n) * 255)
    }
  }
  return px
}

let cached: NativeImage | null = null

/**
 * 取应用 / 托盘图标（首次生成后缓存）。
 * 基准 32px，另附 2x（64px）表示供高分屏使用。
 * 生成失败（极端环境）返回空 `NativeImage`——Tray 仍可创建，仅无图标，不崩。
 */
export function getAppIcon(): NativeImage {
  if (cached) return cached
  try {
    const size = 32
    const img = nativeImage.createFromBuffer(encodePng(size, size, drawLogo(size)))
    img.addRepresentation({
      scaleFactor: 2,
      buffer: encodePng(size * 2, size * 2, drawLogo(size * 2, 4))
    })
    cached = img
  } catch {
    cached = nativeImage.createEmpty()
  }
  return cached
}

// ── macOS 菜单栏模板图（纯字形，系统着色）─────────────────────────────────

/**
 * 「P」字形外接框（1024 画布坐标）：x 256–675、y 164–875，中心 (465.5, 519.5)，高 712、宽 420。
 * 模板图按外接框居中，故横向参考点用 466 而非底板中心 512。
 *
 * 高度必须取**实际外接框**：竖笔 250→790，但碗的线宽向外扩 P_W(86)，顶端 455−190−86=179、
 * 底端 455+190+86=731 之外，竖笔两端还有半圆帽——250−86=164、790+86=876。旧「D」字形
 * 高 532、外接框正好是 246–778，所以那时写 540 无碍；换成 P 后若仍用 540，k 会被算大，
 * 模板图按 540 居中裁切，字形上下各被切掉约 54 画布单位（可见高度只剩 85%）。
 */
const GLYPH_H = 712
const GLYPH_CX = 466
const GLYPH_CY = 519.5
const GLYPH_LEFT = 256

/**
 * 生成纯字形 RGBA 像素：无底板，RGB 恒为 0（黑），只写 alpha——模板图只看 alpha。
 * `size` 为画布边长（px），字形高 `glyphH`（px）并按外接框居中；ss×ss 超采样抗锯齿。
 * 横向微移使竖笔左边缘落在整像素上，1x 屏上竖笔不发虚。
 */
function drawGlyph(size: number, glyphH: number, ss = 8): Uint8Array {
  const px = new Uint8Array(size * size * 4)
  const k = GLYPH_H / glyphH // 每像素对应的画布单位
  const left = size / 2 - (GLYPH_CX - GLYPH_LEFT) / k // 竖笔左边缘所在像素位置
  const dx = Math.round(left) - left
  const n = ss * ss
  for (let py = 0; py < size; py++) {
    for (let pxl = 0; pxl < size; pxl++) {
      let cov = 0
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const x = GLYPH_CX + (pxl + (sx + 0.5) / ss - size / 2 - dx) * k
          const y = GLYPH_CY + (py + (sy + 0.5) / ss - size / 2) * k
          if (inShape(x, y)) cov++
        }
      }
      px[(py * size + pxl) * 4 + 3] = Math.round((cov / n) * 255)
    }
  }
  return px
}

let trayCached: NativeImage | null = null

/**
 * 取托盘图标（首次生成后缓存）。
 * - macOS：18pt 画布、字形高 16pt 的单色模板图（附 2x），与系统及其他应用的菜单栏图标同尺寸；
 *   `setTemplateImage(true)` 后由系统按浅色 / 深色 / 壁纸染色菜单栏及点开高亮自动着色。
 *   不能用彩色应用图标：32px 会按 32pt 显示，几乎撑满菜单栏，且颜色不随菜单栏变化。
 * - 其它平台：沿用彩色应用图标。
 */
export function getTrayIcon(): NativeImage {
  if (process.platform !== 'darwin') return getAppIcon()
  if (trayCached) return trayCached
  try {
    const img = nativeImage.createFromBuffer(encodePng(18, 18, drawGlyph(18, 16)))
    img.addRepresentation({ scaleFactor: 2, buffer: encodePng(36, 36, drawGlyph(36, 32, 4)) })
    img.setTemplateImage(true)
    trayCached = img
  } catch {
    trayCached = nativeImage.createEmpty()
  }
  return trayCached
}
