import { describe, expect, it } from 'vitest'
import { DEFAULT_TAIL_LENGTH, MAX_TAIL_LENGTH, distinguishingTailLength, splitForMiddleTruncation } from './middle-truncate'

describe('splitForMiddleTruncation', () => {
  it('keeps the index and the extension of a long drawing name in the tail', () => {
    const name = 'Wohnanlage-Schlosspark_Grundriss_1OG_Index-C.pdf'
    const { head, tail } = splitForMiddleTruncation(name)
    expect(tail).toBe('_1OG_Index-C.pdf')
    expect(tail).toHaveLength(DEFAULT_TAIL_LENGTH)
    expect(head + tail).toBe(name)
  })

  it('tells two Fassungen apart by their tails even when the heads are identical', () => {
    const older = splitForMiddleTruncation('Wohnanlage-Schlosspark_Grundriss_1OG_Index-B.pdf')
    const newer = splitForMiddleTruncation('Wohnanlage-Schlosspark_Grundriss_1OG_Index-C.pdf')
    expect(older.head).toBe(newer.head)
    expect(older.tail).not.toBe(newer.tail)
  })

  it('does not split a name that is short, or only a little longer than its tail', () => {
    expect(splitForMiddleTruncation('Grundriss_C.pdf')).toEqual({ head: '', tail: 'Grundriss_C.pdf' })
    expect(splitForMiddleTruncation('abcdefghij', 8)).toEqual({ head: '', tail: 'abcdefghij' })
    expect(splitForMiddleTruncation('abcdefghijkl', 8)).toEqual({ head: 'abcd', tail: 'efghijkl' })
  })

  it('never cuts through a surrogate pair', () => {
    const { head, tail } = splitForMiddleTruncation('Skizze-😀-Entwurf-sehr-lang-😀.pdf', 6)
    expect(tail).toBe('-😀.pdf')
    expect(Array.from(tail)).toHaveLength(6)
    expect(head.endsWith('lang')).toBe(true)
  })

  it('treats a nonsense tail length as one character', () => {
    expect(splitForMiddleTruncation('abcdefgh', 0).tail).toBe('h')
  })
})

describe('distinguishingTailLength', () => {
  const older = 'Wohnanlage-Schlosspark_Haus-B_Grundriss_1OG_Index_B_2026-09-14.pdf'
  const newer = 'Wohnanlage-Schlosspark_Haus-B_Grundriss_1OG_Index_C_2026-10-02.pdf'

  it('keeps the index and its label when two names differ there', () => {
    const tail = distinguishingTailLength(older, newer)
    expect(splitForMiddleTruncation(older, tail).tail).toBe('Index_B_2026-09-14.pdf')
    expect(splitForMiddleTruncation(newer, distinguishingTailLength(newer, older)).tail).toBe('Index_C_2026-10-02.pdf')
  })

  it('never keeps less than the minimum, nor more than the maximum', () => {
    expect(distinguishingTailLength('Grundriss_1OG_B.pdf', 'Grundriss_1OG_C.pdf')).toBe(DEFAULT_TAIL_LENGTH)
    expect(distinguishingTailLength(`A${'x'.repeat(60)}.pdf`, `B${'x'.repeat(60)}.pdf`)).toBe(MAX_TAIL_LENGTH)
  })

  it('falls back to the minimum for identical names', () => {
    expect(distinguishingTailLength(older, older)).toBe(DEFAULT_TAIL_LENGTH)
    expect(distinguishingTailLength('kurz.pdf', 'kurz.pdf')).toBe(8)
  })
})
