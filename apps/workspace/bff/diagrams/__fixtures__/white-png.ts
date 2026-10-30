/** A real PNG for the underlay specs, made here so no image file is committed. */

import { deflateSync } from 'node:zlib'

/** A real PNG of `width` by `height` white pixels, palette-free greyscale. */
export function whitePng(width: number, height: number): Uint8Array {
  const crc = (bytes: Buffer) => {
    let c = ~0
    for (const byte of bytes) {
      c ^= byte
      for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1))
    }
    return (~c >>> 0) >>> 0
  }
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(4)
    head.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const tail = Buffer.alloc(4)
    tail.writeUInt32BE(crc(body))
    return Buffer.concat([head, body, tail])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 0
  const rows = Buffer.alloc((width + 1) * height, 0xff)
  for (let y = 0; y < height; y++) rows[y * (width + 1)] = 0
  return new Uint8Array(
    Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))])
  )
}
