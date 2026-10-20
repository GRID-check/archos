/**
 * @vitest-environment node
 */
import { describe, test, expect } from 'vitest'
import { FILE_NOTE_MIN_CHARS, offersFileNote } from './file-note-chip'
import { ANSWER_KINDS, type AnswerKind } from '@/lib/conversations/message-answer-meta'

const long = 'x'.repeat(FILE_NOTE_MIN_CHARS + 1)
const short = 'x'.repeat(FILE_NOTE_MIN_CHARS)

describe('offersFileNote', () => {
  test('a long walkthrough in a project earns the chip', () => {
    expect(offersFileNote({ kind: 'walkthrough', projectId: 'p1', body: long })).toBe(true)
  })

  test('so does a ruling — the two shapes an office puts in a folder', () => {
    expect(offersFileNote({ kind: 'ruling', projectId: 'p1', body: long })).toBe(true)
  })

  test('every other answer kind is silent', () => {
    const offered = (ANSWER_KINDS as readonly AnswerKind[]).filter((kind) =>
      offersFileNote({ kind, projectId: 'p1', body: long })
    )
    expect(offered).toEqual(['walkthrough', 'ruling'])
  })

  test('outside a project there is nowhere to file it', () => {
    expect(offersFileNote({ kind: 'ruling', projectId: null, body: long })).toBe(false)
    expect(offersFileNote({ kind: 'ruling', body: long })).toBe(false)
  })

  test('a short answer gets no offer — a four-line answer filed is a worse four-line answer', () => {
    expect(offersFileNote({ kind: 'walkthrough', projectId: 'p1', body: short })).toBe(false)
    expect(offersFileNote({ kind: 'walkthrough', projectId: 'p1', body: '' })).toBe(false)
    expect(offersFileNote({ kind: 'walkthrough', projectId: 'p1' })).toBe(false)
  })

  test('whitespace is not length', () => {
    expect(
      offersFileNote({ kind: 'ruling', projectId: 'p1', body: `  ${short}  ` })
    ).toBe(false)
  })

  test('a legacy envelope with no kind is never guessed at', () => {
    // Threads older than `answer_meta.kind` would otherwise put this chip under
    // every greeting they contain.
    expect(offersFileNote({ projectId: 'p1', body: long })).toBe(false)
  })

  test('the threshold is a screenful, and it is stated once', () => {
    expect(FILE_NOTE_MIN_CHARS).toBe(900)
  })
})
