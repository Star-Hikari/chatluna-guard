import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { Context, Logger, Session, h } from 'koishi'

import type { ImageCompressConfig } from './index'

/** 计算帧间差异时缩到 32x32 */
const MOTION_SIZE = 32

let jimpModule: Promise<typeof import('jimp')> | null = null

function loadJimp() {
  jimpModule ??= import('jimp')
  return jimpModule
}

async function readImageBuffer(
  ctx: Context,
  session: Session,
  url: string,
): Promise<Buffer | null> {
  if (url.startsWith('data:')) {
    const index = url.indexOf(',')
    if (index < 0) return null
    return Buffer.from(url.slice(index + 1), 'base64')
  }

  if (url.startsWith('base64://')) {
    return Buffer.from(url.slice('base64://'.length), 'base64')
  }

  if (url.startsWith('file://')) {
    return readFile(fileURLToPath(url))
  }

  if (/^https?:\/\//i.test(url)) {
    const http = (ctx as any).http ?? (session as any).bot?.ctx?.http
    if (typeof http !== 'function') return null
    const { data } = await http(url, {
      method: 'get',
      responseType: 'arraybuffer',
      timeout: 15000,
    })
    return Buffer.from(data)
  }

  return null
}

async function storeImage(
  ctx: Context,
  buffer: Buffer,
  filename: string,
): Promise<string> {
  const storage = (ctx as any).chatluna_storage
  if (typeof storage?.createTempFile === 'function') {
    const file = await storage.createTempFile(buffer, filename)
    if (file?.url) return file.url
  }
  return `data:image/jpeg;base64,${buffer.toString('base64')}`
}

function appendText(message: any, text: string) {
  if (typeof message.content === 'string') {
    message.content += text
  } else if (Array.isArray(message.content)) {
    message.content.push({ type: 'text', text })
  } else {
    message.content = text
  }
}

interface DecodedGif {
  width: number
  height: number
  total: number
  frames: Uint8ClampedArray[]
}

function pickFrameIndices(total: number, count: number): number[] {
  if (total <= count) {
    return Array.from({ length: total }, (_, index) => index)
  }
  if (count <= 1) return [Math.floor((total - 1) / 2)]
  const step = (total - 1) / (count - 1)
  return Array.from({ length: count }, (_, index) => Math.round(index * step))
}

function hasComplexDisposal(reader: any, start: number, end: number): boolean {
  for (let index = start; index < end; index++) {
    const disposal = reader.frameInfo(index)?.disposal
    if (disposal === 2 || disposal === 3) return true
  }
  return false
}

async function decodeGif(
  buffer: Buffer,
  sampleFrames: number,
): Promise<DecodedGif | null> {
  const mod: any = await import('omggif')
  const GifReader = mod.GifReader ?? mod.default?.GifReader
  if (typeof GifReader !== 'function') return null

  const reader = new GifReader(buffer)
  const total = reader.numFrames()
  if (total <= 0) return null

  const indices = pickFrameIndices(total, sampleFrames)
  const width = reader.width
  const height = reader.height
  const canvas = new Uint8ClampedArray(width * height * 4)
  const frames: Uint8ClampedArray[] = []
  let lastDecoded = -1

  for (const target of indices) {
    const needsFullDecode =
      target < lastDecoded ||
      (lastDecoded >= 0 && hasComplexDisposal(reader, lastDecoded, target))

    if (needsFullDecode) {
      canvas.fill(0)
      for (let index = 0; index <= target; index++) {
        reader.decodeAndBlitFrameRGBA(index, canvas)
      }
    } else {
      for (let index = lastDecoded + 1; index <= target; index++) {
        reader.decodeAndBlitFrameRGBA(index, canvas)
      }
    }

    lastDecoded = target
    frames.push(new Uint8ClampedArray(canvas))
  }

  return { width, height, total, frames }
}

function motionScore(frames: any[]): number {
  if (frames.length < 2) return 0

  const thumbs = frames.map((frame) =>
    frame.clone().resize({ w: MOTION_SIZE, h: MOTION_SIZE }).greyscale(),
  )
  let diff = 0
  let samples = 0

  for (let index = 1; index < thumbs.length; index++) {
    const previous = thumbs[index - 1].bitmap.data
    const current = thumbs[index].bitmap.data
    for (let offset = 0; offset < previous.length; offset += 4) {
      diff += Math.abs(previous[offset] - current[offset])
      samples++
    }
  }

  return samples === 0 ? 0 : diff / samples / 255
}

function fitFrame(frame: any, maxEdge: number) {
  if (frame.bitmap.width <= maxEdge && frame.bitmap.height <= maxEdge) {
    return frame
  }
  frame.scaleToFit({ w: maxEdge, h: maxEdge })
  return frame
}

async function compressGif(
  buffer: Buffer,
  config: ImageCompressConfig,
  maxEdge: number,
): Promise<{ buffer: Buffer; note: string; summary: string } | null> {
  const { Jimp } = await loadJimp()
  const sampleFrames = Math.min(8, Math.max(2, config.gifSampleFrames || 4))
  const threshold = Math.min(1, Math.max(0, config.gifMotionThreshold ?? 0.04))
  const cellSize = Math.min(1024, Math.max(256, config.gifCellSize || 512))
  const quality = Math.min(100, Math.max(50, config.gifQuality || 82))

  const decoded = await decodeGif(buffer, sampleFrames)
  if (decoded == null) return null

  const frames = decoded.frames.map(
    (raw) =>
      new Jimp({
        data: Buffer.from(raw),
        width: decoded.width,
        height: decoded.height,
      }),
  )

  const score = motionScore(frames)
  let output: any
  let note: string
  let mode: string

  if (frames.length < 2 || score <= threshold) {
    // 动作幅度小：中间帧就足够表达表情/画面
    output = fitFrame(frames[Math.floor(frames.length / 2)].clone(), maxEdge)
    note = `\n[GIF 动图，已取中间帧（共 ${decoded.total} 帧，帧差 ${score.toFixed(3)}）]`
    mode = `单帧(${decoded.total} 帧, 帧差 ${score.toFixed(3)})`
  } else {
    // 动作明显：2×2 拼图保留时间顺序
    const columns = 2
    const rows = Math.ceil(frames.length / columns)
    const sheet = new Jimp({
      width: cellSize * columns,
      height: cellSize * rows,
      color: 0xffffffff,
    })

    frames.forEach((frame, index) => {
      const copy = fitFrame(frame.clone(), cellSize)
      const x =
        (index % columns) * cellSize +
        Math.floor((cellSize - copy.bitmap.width) / 2)
      const y =
        Math.floor(index / columns) * cellSize +
        Math.floor((cellSize - copy.bitmap.height) / 2)
      sheet.composite(copy, x, y)
    })

    output = sheet
    note = `\n[GIF 动图，${columns}×${rows} 采样帧（左上→右下，共 ${decoded.total} 帧，帧差 ${score.toFixed(3)}）]`
    mode = `拼图(${frames.length} 帧, 帧差 ${score.toFixed(3)})`
  }

  const encoded = Buffer.from(await output.getBuffer('image/jpeg', { quality }))
  if (encoded.length >= buffer.length) return null

  return {
    buffer: encoded,
    note,
    summary: `${decoded.width}x${decoded.height} ${(buffer.length / 1024).toFixed(0)}KB -> ${output.bitmap.width}x${output.bitmap.height} ${(encoded.length / 1024).toFixed(0)}KB ${mode}`,
  }
}

/**
 * 发送前压缩超大图片。
 *
 * - 静态图：体积 >= minSizeMB 或长边 >= minEdge 时缩到 maxEdge 并转 JPEG；
 * - GIF：超过 gifMinSizeMB 且 gifEnabled 开启时，按帧差自适应——
 *   动作小取中间帧，动作大取 4 帧 2×2 拼图；
 * - 优先级 -200：必须早于 ChatLuna 默认图片处理器（-100），否则原图会先被写进
 *   message.content，之后再改 element.attrs 已经来不及。
 */
export function installImageCompression(
  ctx: Context,
  logger: Logger,
  config: ImageCompressConfig,
) {
  if (!config.enabled) return

  const maxEdge = Math.min(4096, Math.max(512, config.maxEdge || 1920))
  const quality = Math.min(100, Math.max(50, config.quality || 88))
  const minBytes = Math.max(0, config.minSizeMB ?? 0.75) * 1024 * 1024
  const minEdge = Math.min(8192, Math.max(0, config.minEdge ?? 1600))
  const gifMinBytes =
    Math.max(0, config.gifMinSizeMB ?? 0.5) * 1024 * 1024

  const dispose = ctx.chatluna.messageTransformer.intercept(
    'img',
    async (session, element, message) => {
      const attrs = (element.attrs ??= {})
      if (attrs['guard-compressed']) return false

      try {
        const url = String(attrs.url ?? attrs.src ?? '')
        if (!url) return false

        const buffer = await readImageBuffer(ctx, session, url)
        if (buffer == null) return false

        const isGif = buffer.subarray(0, 6).toString('ascii').startsWith('GIF8')

        if (isGif) {
          if (!config.gifEnabled) return false
          if (buffer.length < gifMinBytes) return false

          const result = await compressGif(buffer, config, maxEdge)
          if (result == null) return false

          const filename = `guard-gif-${Date.now()}.jpg`
          const nextUrl = await storeImage(ctx, result.buffer, filename)

          attrs.url = nextUrl
          attrs.src = nextUrl
          attrs.filename = filename
          attrs.ext = 'jpg'
          attrs['guard-compressed'] = true
          appendText(message, result.note)

          logger.info(`[guard] GIF 压缩 ${result.summary}`)
          return false
        }

        const { Jimp } = await loadJimp()
        const image = await Jimp.read(buffer)
        const width = image.bitmap.width
        const height = image.bitmap.height

        if (
          buffer.length < minBytes &&
          Math.max(width, height) <= minEdge
        ) {
          return false
        }

        image.scaleToFit({ w: maxEdge, h: maxEdge })
        const output = await image.getBuffer('image/jpeg', { quality })

        if (output.length >= buffer.length) return false

        const filename = `guard-${Date.now()}.jpg`
        const nextUrl = await storeImage(ctx, Buffer.from(output), filename)

        attrs.url = nextUrl
        attrs.src = nextUrl
        attrs.filename = filename
        attrs.ext = 'jpg'
        attrs['guard-compressed'] = true

        logger.info(
          `[guard] 图片压缩 ${width}x${height} ${(buffer.length / 1024).toFixed(0)}KB` +
            ` -> ${image.bitmap.width}x${image.bitmap.height} ${(output.length / 1024).toFixed(0)}KB`,
        )
      } catch (error) {
        logger.warn('[guard] 图片压缩失败，已回退原图：', error)
      }

      return false
    },
    -200,
  )

  ctx.effect(() => dispose)
}