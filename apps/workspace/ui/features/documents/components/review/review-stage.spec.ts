/**
 * @vitest-environment node
 */
/**
 * A card on the sheet keeps inside the review's free stage: never under the
 * toolbars at the canvas's foot, nor under the chips of who is out of view
 * below them (at 1440x900 „Lena · Seite 2" lay over the open card's reply
 * field, and Piloti's answer grew the card under the viewer's pill).
 */

import { describe, expect, it } from 'vitest'
import { covers, fitCard, MIN_CARD_HEIGHT } from './review-stage'

const STAGE = { top: 64, bottom: 800 }

describe('fitCard', () => {
  it('leaves a card that fits where it hangs', () => {
    expect(fitCard(300, 400, STAGE, true)).toEqual({ shift: 0, maxHeight: 736 })
  })

  it('moves a card beside its mark up by what would run into the foot', () => {
    expect(fitCard(445, 440, STAGE, true)).toEqual({ shift: 85, maxHeight: 736 })
  })

  it('never moves it past the head of the stage', () => {
    expect(fitCard(100, 736, STAGE, true).shift).toBe(36)
  })

  it('keeps the hairline inside the card when the mark is at the very foot', () => {
    // Its top at 790, 300 tall: moving it the whole 290 would leave the hairline under it.
    expect(fitCard(790, 300, STAGE, true).shift).toBe(272)
  })

  it('shortens a card under its mark instead of moving it over the mark', () => {
    expect(fitCard(500, 400, STAGE, false)).toEqual({ shift: 0, maxHeight: 300 })
  })

  it('keeps a card under its mark tall enough for its reply field', () => {
    expect(fitCard(700, 400, STAGE, false).maxHeight).toBe(MIN_CARD_HEIGHT)
  })

  it('is never taller than the stage', () => {
    expect(fitCard(64, 2000, STAGE, false).maxHeight).toBe(736)
    expect(fitCard(64, 2000, STAGE, true).maxHeight).toBe(736)
  })
})

describe('covers', () => {
  const card = { top: 445, bottom: 790, left: 312, right: 632 }

  it('says a chip over the card covers it', () => {
    expect(covers(card, { top: 780, bottom: 800, left: 495, right: 593 })).toBe(true)
  })

  it('says a chip below the card or beside it does not', () => {
    expect(covers(card, { top: 816, bottom: 836, left: 495, right: 593 })).toBe(false)
    expect(covers(card, { top: 780, bottom: 800, left: 640, right: 700 })).toBe(false)
  })
})
