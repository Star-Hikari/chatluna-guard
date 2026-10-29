declare module 'omggif' {
  export interface GifFrameInfo {
    disposal: number
    delay: number
    width: number
    height: number
    x: number
    y: number
  }

  export class GifReader {
    constructor(buffer: Buffer | Uint8Array)
    readonly width: number
    readonly height: number
    numFrames(): number
    frameInfo(index: number): GifFrameInfo
    decodeAndBlitFrameRGBA(index: number, pixels: Uint8ClampedArray): void
  }
}