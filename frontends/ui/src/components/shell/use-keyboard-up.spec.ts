/**
 * When the phone tab bar stands down: while the on-screen keyboard is up, as
 * each browser reports it, and not merely because a field holds the focus.
 */
import { afterEach, describe, expect, it } from 'vitest'

import { isTypingTarget, keyboardIsUp, type ViewportReading } from './use-keyboard-up'

/** iPhone 15 Pro portrait, nothing up. */
const RESTING: ViewportReading = {
  layoutHeight: 852,
  visualHeight: 852,
  visualScale: 1,
  tallestLayoutHeight: 852,
  fieldFocused: true,
}

describe('keyboardIsUp', () => {
  it('iOS: the visual viewport shrinks under a focused field', () => {
    expect(keyboardIsUp({ ...RESTING, visualHeight: 512 })).toBe(true)
  })

  it('Chromium with resizes-content: the layout viewport itself shrinks', () => {
    expect(keyboardIsUp({ ...RESTING, layoutHeight: 500, visualHeight: 500 })).toBe(true)
  })

  it('a focus with no keyboard (programmatic, or a hardware keyboard) keeps the bar', () => {
    expect(keyboardIsUp(RESTING)).toBe(false)
  })

  it('a browser toolbar collapsing is not a keyboard', () => {
    expect(keyboardIsUp({ ...RESTING, visualHeight: 790 })).toBe(false)
  })

  it('pinch zoom shrinks the visual viewport and is not a keyboard', () => {
    expect(keyboardIsUp({ ...RESTING, visualHeight: 400, visualScale: 2 })).toBe(false)
  })

  it('without a focused field nothing is typing, whatever the viewport says', () => {
    expect(keyboardIsUp({ ...RESTING, visualHeight: 512, fieldFocused: false })).toBe(false)
  })
})

describe('isTypingTarget', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  const mount = (html: string): Element => {
    document.body.innerHTML = html
    return document.body.querySelector('[data-target]')!
  }

  it('counts the fields a keyboard types into', () => {
    expect(isTypingTarget(mount('<textarea data-target></textarea>'))).toBe(true)
    expect(isTypingTarget(mount('<input data-target type="search" />'))).toBe(true)
    expect(isTypingTarget(mount('<input data-target />'))).toBe(true)
  })

  it('not a checkbox, a button or a read-only field', () => {
    expect(isTypingTarget(mount('<input data-target type="checkbox" />'))).toBe(false)
    expect(isTypingTarget(mount('<button data-target>Senden</button>'))).toBe(false)
    expect(isTypingTarget(mount('<input data-target readonly />'))).toBe(false)
  })

  it('not a field inside a dialog, which covers the bar on its own', () => {
    expect(isTypingTarget(mount('<div role="dialog"><input data-target /></div>'))).toBe(false)
  })
})
