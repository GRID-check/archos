/**
 * @vitest-environment node
 */

/**
 * One German word per concept in the product's copy (CONTEXT.md, „Aufgabe“,
 * „Lauf“, „Chat“, „Zuständig“).
 *
 * The work handed to Piloti is an „Aufgabe“ and one attempt at it a „Lauf“; a
 * thread is a „Chat“; the person who answers for something is „zuständig“. The
 * copy used five words for those two things and three for a chat (Auftrag,
 * Aufgabe, Lauf, Job, Run; Chat, Unterhaltung, Gespräch), and a reader
 * scanning for one could not know the others meant the same. This is the
 * ratchet for the retired words, over every German value.
 *
 * {@link KEPT} lists the values where a retired word means something else,
 * each with why.
 */

import { describe, expect, it } from 'vitest'
import { de } from './dictionaries/de'

/** The retired words, each with the one that replaced it. */
const RETIRED: readonly { word: RegExp; use: string }[] = [
  { word: /\bAuftr(ag|äge|ags)\b/, use: 'Aufgabe (the work) or Lauf (one attempt)' },
  { word: /\bUnterhaltung(en)?\b/, use: 'Chat' },
  { word: /\bGespräch(e|s)?\b/, use: 'Chat' },
  { word: /\b[Vv]erantwortlich\b/, use: 'zuständig' },
]

/** Values where a retired word names another concept, by dictionary path. */
const KEPT: Readonly<Record<string, string>> = {
  'projects.lifecycle.closeDialog.outcome.cancelledHint':
    'a client’s commission to the office (a withdrawn Auftrag), not work handed to Piloti',
  'files.lifecycle.submit.orderLabel': 'the instruction a person gives the reviewer of a revision, not work for Piloti',
  'files.lifecycle.submit.needOrder': 'the instruction a person gives the reviewer of a revision, not work for Piloti',
}

function values(node: unknown, path: string, into: [string, string][]): [string, string][] {
  if (typeof node === 'string') into.push([path, node])
  else if (node && typeof node === 'object') {
    for (const [key, child] of Object.entries(node)) values(child, path ? `${path}.${key}` : key, into)
  }
  return into
}

describe('retired German words', () => {
  const all = values(de, '', [])

  it('appear in no German value outside the kept ones', () => {
    const found = all.flatMap(([path, text]) =>
      KEPT[path] ? [] : RETIRED.filter(({ word }) => word.test(text)).map(({ use }) => `${path}: use ${use}`),
    )
    expect(found).toEqual([])
  })

  it('keeps only paths that exist and still carry a retired word', () => {
    const byPath = new Map(all)
    for (const path of Object.keys(KEPT)) {
      const text = byPath.get(path)
      expect(text, path).toBeDefined()
      expect(RETIRED.some(({ word }) => word.test(text ?? '')), path).toBe(true)
    }
  })
})
