import { describe, expect, it } from 'vitest'
import { clampPage, clampZoom, fitWidth, stepZoom, viewerKeyAction } from './pdf-zoom'

const key = (key: string, modifiers: { ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean } = {}) => ({
  key,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  ...modifiers,
})
const outside = { inField: false, overflowsSideways: false }

describe('stepZoom', () => {
  it('walks the ladder one rung at a time and stops at its ends', () => {
    expect(stepZoom(1, 1)).toBe(1.25)
    expect(stepZoom(1, -1)).toBe(0.75)
    expect(stepZoom(4, 1)).toBe(4)
    expect(stepZoom(0.5, -1)).toBe(0.5)
  })

  it('from between two rungs, after a pinch, goes to the nearer rung that way', () => {
    expect(stepZoom(1.1, 1)).toBe(1.25)
    expect(stepZoom(1.1, -1)).toBe(1)
  })

  it('treats garbage as the fit', () => {
    expect(clampZoom(Number.NaN)).toBe(1)
    expect(clampZoom(-2)).toBe(1)
    expect(clampZoom(40)).toBe(4)
  })
})

describe('clampPage', () => {
  it('holds a page to the document', () => {
    expect(clampPage(0, 5)).toBe(1)
    expect(clampPage(9, 5)).toBe(5)
    expect(clampPage(2.7, 5)).toBe(2)
  })
})

describe('fitWidth', () => {
  const frame = { frameWidth: 1024, frameHeight: 600, aspect: Math.SQRT2, gutter: 24, verticalPadding: 80 }

  it('fills the width less the gutter', () => {
    expect(fitWidth({ ...frame, mode: 'width' })).toBe(1000)
  })

  it('fits a portrait page whole by its height', () => {
    expect(fitWidth({ ...frame, mode: 'page' })).toBeCloseTo(520 / Math.SQRT2)
  })

  it('never fits a page wider than the frame', () => {
    expect(fitWidth({ ...frame, mode: 'page', frameHeight: 5000 })).toBe(1000)
  })
})

describe('viewerKeyAction', () => {
  it('turns pages', () => {
    expect(viewerKeyAction(key('PageDown'), outside)).toEqual({ kind: 'page', to: 'next' })
    expect(viewerKeyAction(key('PageUp'), outside)).toEqual({ kind: 'page', to: 'previous' })
    expect(viewerKeyAction(key('Home'), outside)).toEqual({ kind: 'page', to: 'first' })
    expect(viewerKeyAction(key('End'), outside)).toEqual({ kind: 'page', to: 'last' })
  })

  it('leaves left and right to scrolling once the page is wider than the frame', () => {
    expect(viewerKeyAction(key('ArrowRight'), outside)).toEqual({ kind: 'page', to: 'next' })
    expect(viewerKeyAction(key('ArrowRight'), { ...outside, overflowsSideways: true })).toBeNull()
  })

  it('zooms, fits and searches', () => {
    expect(viewerKeyAction(key('+'), outside)).toEqual({ kind: 'zoom', direction: 1 })
    expect(viewerKeyAction(key('='), outside)).toEqual({ kind: 'zoom', direction: 1 })
    expect(viewerKeyAction(key('-'), outside)).toEqual({ kind: 'zoom', direction: -1 })
    expect(viewerKeyAction(key('0', { ctrlKey: true }), outside)).toEqual({ kind: 'fit' })
    expect(viewerKeyAction(key('f', { metaKey: true }), outside)).toEqual({ kind: 'search' })
    expect(viewerKeyAction(key('0'), outside)).toBeNull()
  })

  it('lets a field keep its keys, except the one that searches', () => {
    const inField = { inField: true, overflowsSideways: false }
    expect(viewerKeyAction(key('End'), inField)).toBeNull()
    expect(viewerKeyAction(key('-'), inField)).toBeNull()
    expect(viewerKeyAction(key('F', { ctrlKey: true }), inField)).toEqual({ kind: 'search' })
  })

  it('stays out of the way of Alt chords', () => {
    expect(viewerKeyAction(key('PageDown', { altKey: true }), outside)).toBeNull()
  })
})
