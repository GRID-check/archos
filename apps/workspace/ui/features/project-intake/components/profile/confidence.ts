/**
 * How sure a value on the Steckbrief is, in words, from what the view already
 * holds: who confirmed it, how many independent sources say it, and whether a
 * source says something else. No number: the reading records no score, and a
 * percentage made up on the client would claim a precision nobody measured
 * („Belegt statt behauptet“). Pure.
 */

import type { ProfileEvidence, Suggestion } from '@/lib/project-intake/types'

export type ConfidenceLevel =
  /** A person confirmed it, or gave it. */
  | 'confirmed'
  /** The documents name different values for it. */
  | 'contested'
  /** Suggested, and two or more independent sources agree. */
  | 'corroborated'
  /** Suggested from one source. */
  | 'single'
  /** Suggested, with nothing to show where from. */
  | 'unsupported'

export interface Confidence {
  level: ConfidenceLevel
  /**
   * Independent sources: each distinct document, the address search, a
   * derivation. For `contested`, the number of different values found.
   */
  count: number
  /** For `confirmed`: the person typed it themselves rather than taking a suggestion. */
  ownAnswer: boolean
}

/** One source per document (two quotes from the Baubeschreibung are one source), one per other kind. */
export function distinctSources(evidence: readonly ProfileEvidence[]): number {
  const sources = new Set<string>()
  for (const entry of evidence) {
    if (entry.kind === 'person') continue
    sources.add(entry.kind === 'document' ? `document:${entry.fileName.normalize('NFC').toLowerCase()}` : entry.kind)
  }
  return sources.size
}

/** What a confidence is read from: a suggestion, or one value a contradiction offers. */
export interface ConfidenceSource {
  state: Suggestion['state']
  evidence: readonly ProfileEvidence[]
  alternatives: readonly Suggestion['alternatives'][number][]
}

export function confidenceOf(item: ConfidenceSource): Confidence {
  const ownAnswer = item.evidence.length > 0 && item.evidence.every((entry) => entry.kind === 'person')
  if (item.state === 'contested') {
    return { level: 'contested', count: 1 + item.alternatives.length, ownAnswer: false }
  }
  const count = distinctSources(item.evidence)
  if (item.state === 'confirmed') return { level: 'confirmed', count, ownAnswer }
  if (count >= 2) return { level: 'corroborated', count, ownAnswer: false }
  if (count === 1) return { level: 'single', count, ownAnswer: false }
  return { level: 'unsupported', count, ownAnswer: false }
}
