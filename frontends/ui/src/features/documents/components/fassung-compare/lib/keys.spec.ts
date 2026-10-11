import { describe, expect, it } from 'vitest'
import { compareKeyAction, keyBelongsToTarget } from './keys'

describe('compareKeyAction', () => {
  it('turns pages with the arrows', () => {
    expect(compareKeyAction({ key: 'ArrowRight' })).toEqual({ type: 'page', delta: 1 })
    expect(compareKeyAction({ key: 'ArrowLeft' })).toEqual({ type: 'page', delta: -1 })
  })

  it('turns pages with Page Up / Down and goes to the ends with Home and End', () => {
    expect(compareKeyAction({ key: 'PageDown' })).toEqual({ type: 'page', delta: 1 })
    expect(compareKeyAction({ key: 'PageUp' })).toEqual({ type: 'page', delta: -1 })
    expect(compareKeyAction({ key: 'Home' })).toEqual({ type: 'edge', edge: 'first' })
    expect(compareKeyAction({ key: 'End' })).toEqual({ type: 'edge', edge: 'last' })
  })

  it('switches mode with 1, 2 and 3', () => {
    expect(compareKeyAction({ key: '1' })).toEqual({ type: 'mode', mode: 'side' })
    expect(compareKeyAction({ key: '2' })).toEqual({ type: 'mode', mode: 'overlay' })
    expect(compareKeyAction({ key: '3' })).toEqual({ type: 'mode', mode: 'swipe' })
  })

  it('leaves everything else, and every chord, to the browser', () => {
    expect(compareKeyAction({ key: '4' })).toBeNull()
    expect(compareKeyAction({ key: 'Escape' })).toBeNull()
    expect(compareKeyAction({ key: '1', metaKey: true })).toBeNull()
    expect(compareKeyAction({ key: 'ArrowRight', ctrlKey: true })).toBeNull()
    expect(compareKeyAction({ key: 'ArrowRight', altKey: true })).toBeNull()
  })
})

describe('keyBelongsToTarget', () => {
  const make = (html: string): HTMLElement => {
    const host = document.createElement('div')
    host.innerHTML = html
    return host.firstElementChild as HTMLElement
  }

  it('lets a text field keep every key', () => {
    expect(keyBelongsToTarget('1', make('<input type="text">'))).toBe(true)
    expect(keyBelongsToTarget('ArrowLeft', make('<textarea></textarea>'))).toBe(true)
  })

  it('lets a range and the swipe divider keep the arrows but not the digits', () => {
    const range = make('<input type="range">')
    expect(keyBelongsToTarget('ArrowRight', range)).toBe(true)
    expect(keyBelongsToTarget('2', range)).toBe(false)
    const divider = make('<div role="slider" tabindex="0"></div>')
    expect(keyBelongsToTarget('ArrowLeft', divider)).toBe(true)
    expect(keyBelongsToTarget('Home', divider)).toBe(true)
    expect(keyBelongsToTarget('End', range)).toBe(true)
    expect(keyBelongsToTarget('3', divider)).toBe(false)
  })

  it('does not claim a plain button or the document', () => {
    expect(keyBelongsToTarget('ArrowRight', make('<button>x</button>'))).toBe(false)
    expect(keyBelongsToTarget('ArrowRight', null)).toBe(false)
  })
})
