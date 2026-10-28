import type { Translator } from '@/i18n'
import { citedLoci, type CitedDocument, type CitationLocus } from '../../../lib/citations'
import { documentShortName } from '../../../lib/document-names'
import { type AnswerDegradation, type DeepResearchCutoff } from '../../../lib/turn-events'
import { type FanCard } from '../../../lib/retrieval-rounds'

/** Copy for the caveat lines, all under one dictionary group. */
export const LIMIT = 'thinking.node.limits.'

/**
 * A cut-off deep run needs at least this much clock behind it before the panel
 * names a duration. Below a minute the sentence would read "stopped after 0
 * minutes", which is a true number that says nothing — and the cause line
 * ("reached its time limit") already carries the fact that matters.
 */
const MIN_REPORTED_MINUTES = 1

/**
 * Dictionary key per degradation, total over the closed set: a token added to
 * `ANSWER_DEGRADATIONS` without a line here fails the typecheck, rather than
 * rendering as whichever line a fallback branch happened to pick.
 */
const DEGRADATION_KEYS: Record<AnswerDegradation, string> = {
  no_report_file: 'noReport',
  no_valid_citations: 'noCitations',
  cards_generation_failed: 'noCards',
  basis_unread: 'basisUnread',
}

export function limitations(
  cutoff: DeepResearchCutoff | null,
  degradations: AnswerDegradation[],
  t: Translator
): Array<{ text: string; warn: boolean }> {
  const lines: Array<{ text: string; warn: boolean }> = []

  if (cutoff) {
    // An unknown reason token still gets a line: THAT the run stopped early is
    // the part the reader needs, and it is true whatever ended it.
    const cause =
      cutoff.reason === 'wall_clock' ? 'time' : cutoff.reason === 'step_limit' ? 'steps' : 'other'
    const outcome = cutoff.salvaged ? 'salvaged' : 'nothing'
    lines.push({
      text: `${t(`${LIMIT}deepCutoff.${cause}`)} ${t(`${LIMIT}deepCutoff.${outcome}`)}`,
      warn: false,
    })

    // What had been gathered when the clock ran out. Zero sources is left
    // unsaid rather than counted — "0 Quellen" is a true number that reads as a
    // failure, and `nothing` above has already said the honest version of it.
    const context: string[] = []
    if (cutoff.sourceCount) {
      context.push(t(`${LIMIT}deepCutoff.sources`, { count: cutoff.sourceCount }))
    }
    // FLOORED, not rounded: "it stopped after 1 minute" is a claim, and 41
    // seconds rounded up would make the panel overstate the run by half.
    const minutes = Math.floor((cutoff.elapsedSeconds ?? 0) / 60)
    if (minutes >= MIN_REPORTED_MINUTES) {
      context.push(t(`${LIMIT}deepCutoff.after`, { minutes }))
    }
    if (context.length > 0) lines.push({ text: context.join(' '), warn: false })
  }

  for (const reason of degradations) {
    lines.push({ text: t(`${LIMIT}degraded.${DEGRADATION_KEYS[reason]}`), warn: true })
  }

  return lines
}

/**
 * The locus a folded single-file layer names beside the document: the cited
 * passage when the answer cited one, else nothing. A document the answer never
 * cited names NO locus — its fan card already reads "abgerufen, nicht
 * zitiert", so a fold naming a passage beside it would promise a Beleg the
 * fan withholds. Punkt wins over page — it is the finer address.
 */
function foldLocusOf(doc: CitedDocument): CitationLocus | undefined {
  const loci = citedLoci(doc)
  if (loci.length === 0) return undefined
  return (
    loci.find((locus) => locus.clause?.trim()) ??
    loci.find((locus) => typeof locus.page === 'number') ??
    loci[0]
  )
}

function foldLocusLabel(doc: CitedDocument, t: Translator): string | undefined {
  const locus = foldLocusOf(doc)
  if (!locus) return undefined
  const clause = locus.clause?.trim()
  const page = typeof locus.page === 'number' ? locus.page : undefined
  if (clause && page !== undefined)
    return t('thinking.node.roundFoldLocusClausePage', { clause, page })
  if (clause) return t('thinking.node.roundFoldLocusClause', { clause })
  if (page !== undefined) return t('thinking.node.roundFoldLocusPage', { page })
  return undefined
}

/** The name a fan slot folds to: the card's short name, else the ledger's own. */
const foldName = (slot: FanCard): string =>
  slot.card
    ? documentShortName(slot.card.fileName ?? slot.card.title, slot.card.title)
    : documentShortName(slot.name, slot.title)

/**
 * The locus beside a folded single file: the FIRST passage that round read,
 * when the ledger accounted for the round. The fan under it lists them all,
 * and a fold that fell back to the turn aggregate would name a page a
 * different round read. Without a ledger it stays the cited passage (see
 * `foldLocusOf`).
 */
const foldLocus = (slot: FanCard, t: Translator): string | undefined => {
  if (slot.loci) return slot.loci[0]?.detail
  return slot.card ? foldLocusLabel(slot.card, t) : undefined
}

/**
 * The scent of a folded fan, from the round's own slots: one file is document +
 * its locus (bare name when there is none to name — see `foldLocus`), two
 * files are both names, three or more are count + first name + "u.a.". Short
 * names throughout — the edition tail says nothing a folded layer needs. Empty
 * when the fetch returned nothing (the layer is then not foldable, so this
 * never renders).
 */
export function foldSummary(roundCards: FanCard[], t: Translator): string {
  const names = roundCards.map(foldName)
  if (names.length === 0) return ''
  if (names.length === 1) {
    const locus = foldLocus(roundCards[0]!, t)
    return locus
      ? t('thinking.node.roundFoldOne', { name: names[0], locus })
      : t('thinking.node.roundFoldOneBare', { name: names[0] })
  }
  if (names.length === 2)
    return t('thinking.node.roundFoldTwo', { first: names[0], second: names[1] })
  return t('thinking.node.roundFoldMany', { count: names.length, first: names[0] })
}
