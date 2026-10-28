/**
 * @vitest-environment node
 */

/**
 * The guard that keeps the inbox telling people what Piloti did in their words.
 *
 * The inbox is where a person learns what Piloti did for them, so its Piloti
 * notices are read as a colleague's sentence: which mark in which document,
 * why it did not work, what to do now. Two ways that broke before:
 *
 * - A failure read „Piloti konnte Anmerkung 4 nicht abschließen“: no cause,
 *   no document, no next step. The cause is now a class of the stored reason
 *   (`lib/annotations/wake-end-reason.ts`) and a proposal's notice is worded by
 *   what it changes (`PROPOSAL_NOTICE_VARIANTS`); a class without words would
 *   fall back to the general sentence silently, so every class must have its
 *   own, in every locale.
 * - System words reach copy: the code says wake, turn, proposal and
 *   delegation, the Prüfansicht says Anmerkung, Verlauf, Vorschlag and
 *   „an Piloti delegieren“.
 */

import { describe, expect, it } from 'vitest'
import { WAKE_END_REASON_KINDS } from '@/lib/annotations/wake-end-reason'
import { PROPOSAL_NOTICE_VARIANTS } from '@/lib/proposals/types'
import { de, en } from './dictionaries'
import { getByPath } from './translate'

const TYPES = 'collaboration.inbox.types'
const AGENT_TYPES = ['agentWorkDone', 'agentWorkFailed', 'agentAsksYou', 'agentProposalWaiting'] as const
const MARK_TYPES = ['agentWorkDone', 'agentWorkFailed', 'agentAsksYou'] as const

/** The words of the code, never of the copy. „Plan“ too: a file is never called one. */
const JARGON: Record<'de' | 'en', RegExp> = {
  de: /\b(Wake|geweckt|Turn|Proposal|Delegation|Plan|Pläne)\b/iu,
  en: /\b(wake|woken|turn|delegation|plans?)\b/i,
}

function leaves(node: unknown, path: string, found: Array<[string, string]> = []): Array<[string, string]> {
  if (typeof node === 'string') found.push([path, node])
  else if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) leaves(value, `${path}.${key}`, found)
  }
  return found
}

const LOCALES = [
  ['de', de],
  ['en', en],
] as const

describe('Piloti’s inbox notices', () => {
  for (const [locale, dictionary] of LOCALES) {
    it(`${locale}: every failure class says why, in words of its own`, () => {
      const missing = WAKE_END_REASON_KINDS.filter(
        (kind) => typeof getByPath(dictionary, `${TYPES}.agentWorkFailed.variants.${kind}.body`) !== 'string',
      )
      expect(missing).toEqual([])
    })

    it(`${locale}: every kind of proposal says what it changes`, () => {
      const missing = PROPOSAL_NOTICE_VARIANTS.filter(
        (variant) => typeof getByPath(dictionary, `${TYPES}.agentProposalWaiting.variants.${variant}.title`) !== 'string',
      )
      expect(missing).toEqual([])
    })

    it(`${locale}: a notice about a mark names the mark and the document`, () => {
      for (const type of MARK_TYPES) {
        expect(getByPath(dictionary, `${TYPES}.${type}.titleRelated`)).toMatch(/\{related\}.*\{subject\}/)
        expect(getByPath(dictionary, `${TYPES}.${type}.titleRelatedNoSubject`)).toMatch(/\{related\}/)
      }
    })

    it(`${locale}: no system words`, () => {
      const offenders = AGENT_TYPES.flatMap((type) =>
        leaves(getByPath(dictionary, `${TYPES}.${type}`), `${TYPES}.${type}`),
      )
        .filter(([, text]) => JARGON[locale].test(text))
        .map(([path, text]) => `${path}: ${text}`)
      expect(offenders).toEqual([])
    })
  }
})
