/**
 * The picture a mark on a model keeps: the arithmetic of downsizing, with the
 * decoder injected (the pixels themselves need a browser).
 */

import { describe, expect, it, vi } from 'vitest'
import { MAX_SNAPSHOT_BYTES } from '@/lib/annotations/viewpoint-types'
import { base64Bytes, downsizeSnapshot, fitWithin, SNAPSHOT_MAX_SIDE, type Raster } from './snapshot'

const JPEG = 'data:image/jpeg;base64,'

function raster(width: number, height: number, encode: Raster['toJpeg']): Raster {
  return { width, height, toJpeg: encode }
}

describe('fitWithin', () => {
  it('scales the longest side down to 1500 px and keeps the aspect', () => {
    expect(fitWithin(3000, 2000)).toEqual({ width: 1500, height: 1000 })
    expect(fitWithin(1000, 4000)).toEqual({ width: 375, height: 1500 })
  })

  it('never scales up', () => {
    expect(fitWithin(800, 600)).toEqual({ width: 800, height: 600 })
    expect(fitWithin(SNAPSHOT_MAX_SIDE, 10)).toEqual({ width: SNAPSHOT_MAX_SIDE, height: 10 })
  })

  it('keeps a sliver at least one pixel high', () => {
    expect(fitWithin(30000, 1)).toEqual({ width: 1500, height: 1 })
  })

  it('answers nothing for an empty or broken size', () => {
    expect(fitWithin(0, 0)).toEqual({ width: 0, height: 0 })
    expect(fitWithin(Number.NaN, 10)).toEqual({ width: 0, height: 0 })
  })
})

describe('base64Bytes', () => {
  it('is the decoded length, padding included', () => {
    expect(base64Bytes(btoa('abc'))).toBe(3)
    expect(base64Bytes(btoa('abcd'))).toBe(4)
    expect(base64Bytes(btoa('abcde'))).toBe(5)
  })
})

describe('downsizeSnapshot', () => {
  it('draws the capture at most 1500 px wide as a JPEG at 0.85', async () => {
    const encode = vi.fn(() => `${JPEG}${btoa('small')}`)
    const snapshot = await downsizeSnapshot('data:image/png;base64,AAA', async () => raster(2880, 1800, encode))
    expect(encode).toHaveBeenCalledWith(1500, 938, 0.85)
    expect(snapshot).toEqual({ contentType: 'image/jpeg', dataBase64: btoa('small') })
  })

  it('lowers the quality until the bytes fit the wire', async () => {
    const tooBig = 'A'.repeat(Math.ceil(((MAX_SNAPSHOT_BYTES + 10) * 4) / 3))
    const encode = vi.fn((_w: number, _h: number, quality: number) => `${JPEG}${quality > 0.6 ? tooBig : 'QUFB'}`)
    const snapshot = await downsizeSnapshot('data:image/png;base64,AAA', async () => raster(1000, 500, encode))
    expect(encode.mock.calls.map((call) => call[2])).toEqual([0.85, 0.7, 0.55])
    expect(snapshot?.dataBase64).toBe('QUFB')
  })

  it('gives up rather than sending what the API refuses', async () => {
    const tooBig = 'A'.repeat(Math.ceil(((MAX_SNAPSHOT_BYTES + 10) * 4) / 3))
    expect(await downsizeSnapshot('x', async () => raster(1000, 500, () => `${JPEG}${tooBig}`))).toBeNull()
  })

  it('answers null when the browser cannot decode or encode it', async () => {
    expect(await downsizeSnapshot('x', async () => Promise.reject(new Error('broken')))).toBeNull()
    expect(await downsizeSnapshot('x', async () => raster(10, 10, () => 'data:image/png;base64,AAA'))).toBeNull()
    expect(await downsizeSnapshot('x', async () => raster(0, 0, () => `${JPEG}QUFB`))).toBeNull()
  })
})
