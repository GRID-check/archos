/**
 * Why a document is in quarantine, read back from its stored error (ADR-0086).
 *
 * The content gate in the ingest job ends a matching file with
 * `quarantined:{"reasons":[…],"checked":"full"|"partial"}`
 * (`sources/knowledge_layer/src/llamaindex/screening.py`, `quarantine_error`),
 * and status reconciliation stores that string on the row. Detector samples are
 * already masked by the job; nothing here ever sees a full IBAN.
 *
 * Pure and client-safe: the review list and the upload summary both render it.
 */

import { z } from 'zod'
import type { Translator } from '@/i18n/translate'
import type { NameMatch } from './name-screen'

export const QUARANTINED_PREFIX = 'quarantined:'

/**
 * `details.reason` of the 409 a re-upload onto a quarantined file answers
 * (`assertMayReplaceHeld`, `./quarantine-reviewers`). Here, beside the verdict,
 * because the browser reads it too: the upload row it refuses is not retried,
 * since a retry meets the same 409 until somebody deletes or releases the file.
 */
export const QUARANTINED_REPLACE_REASON = 'quarantined'

/** The error envelope of that 409 (`{ error, code, details: { reason } }`). */
export function isQuarantinedReplaceBody(body: unknown): boolean {
  if (!body || typeof body !== 'object') return false
  const details = (body as { details?: unknown }).details
  return !!details && typeof details === 'object' && (details as { reason?: unknown }).reason === QUARANTINED_REPLACE_REASON
}

const reasonSchema = z.object({
  /**
   * A kind this build does not know (a detector added to the job first) becomes
   * `other` rather than failing the parse: one new reason must not blank the
   * ones that can be read.
   */
  kind: z.enum(['term', 'iban', 'at_svnr', 'credit_card']).or(z.unknown().transform((): 'other' => 'other')),
  term: z.string().optional(),
  count: z.number().int().nonnegative().optional(),
  pages: z.array(z.number().int()).optional(),
  /**
   * `pages` is not every page the reason was found on: the job lists up to 50
   * and cuts the widest reasons first to keep the stored verdict whole
   * (`screening.py`, `quarantine_error`). Absent on a verdict that lists all.
   */
  pages_truncated: z.boolean().optional(),
  sample: z.string().optional(),
})

const verdictSchema = z.object({
  reasons: z.array(reasonSchema),
  checked: z.enum(['full', 'partial']).optional(),
  /** How many reasons the job found and did not list (more than ten, or too long to store whole). */
  omitted: z.number().int().positive().optional(),
})

export type QuarantineReason = z.infer<typeof reasonSchema>
export type QuarantineVerdict = z.infer<typeof verdictSchema>

/** The verdict stored on a quarantined row, or `null` for any other message (or a malformed one). */
export function parseQuarantine(errorMessage: string | null | undefined): QuarantineVerdict | null {
  if (!errorMessage?.startsWith(QUARANTINED_PREFIX)) return null
  try {
    const parsed = verdictSchema.safeParse(JSON.parse(errorMessage.slice(QUARANTINED_PREFIX.length)))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

/**
 * The reasons as the audit trail records them: kinds and terms only
 * (`term:Lohnzettel,iban`), never a detector's masked sample or page text.
 * Cut at 200 characters, inside WorkOS's metadata value limit.
 */
export function auditedQuarantineReasons(verdict: QuarantineVerdict | null): string {
  return (verdict?.reasons ?? [])
    .map((reason) => (reason.kind === 'term' ? `term:${reason.term ?? ''}` : reason.kind))
    .join(',')
    .slice(0, 200)
}

/** One reason without its pages, in the reader's language: `„Lohnzettel“ im Text`. */
export function quarantineReasonHead(reason: QuarantineReason, t: Translator): string {
  const head =
    reason.kind === 'term'
      ? t('screening.reasonTerm', { term: reason.term ?? '' })
      : reason.kind === 'iban'
        ? t('screening.reasonIban', { sample: reason.sample ?? '' })
        : reason.kind === 'at_svnr'
          ? t('screening.reasonSvnr', { sample: reason.sample ?? '' })
          : reason.kind === 'credit_card'
            ? t('screening.reasonCard', { sample: reason.sample ?? '' })
            : t('screening.reasonOther')
  return head.trim()
}

/**
 * How the content check came to hold the file for one reason: who set the rule,
 * and for a number what "found" means. A term is the office's own word; a
 * number is held only when its checksum holds, so a reader can tell a real
 * account number from an order number that merely looks like one.
 */
export function explainQuarantineReason(reason: QuarantineReason, t: Translator): string {
  switch (reason.kind) {
    case 'term':
      return t('screening.basisTerm')
    case 'iban':
      return t('screening.basisIban')
    case 'at_svnr':
      return t('screening.basisSvnr')
    case 'credit_card':
      return t('screening.basisCard')
    default:
      return t('screening.basisOther')
  }
}

/** Said after the last listed page of a reason whose list is cut (`pages_truncated`). */
export const MORE_PAGES_MARK = '…'

/**
 * One reason, as a short phrase in the reader's language: `„Lohnzettel“ im Text · Seite 2`,
 * and `· Seiten 1, 2, …` when the job listed only some of its pages.
 */
export function describeQuarantineReason(reason: QuarantineReason, t: Translator): string {
  const head = quarantineReasonHead(reason, t)
  const pages = reason.pages ?? []
  if (pages.length === 0) return `${head} · ${t('screening.reasonNoPages')}`
  const listed = reason.pages_truncated ? [...pages, MORE_PAGES_MARK] : pages
  return `${head} · ${t('screening.reasonPages', { count: pages.length, pages: listed.join(', ') })}`
}

/**
 * Where a finding is, as a citation points into a document: the page, and the
 * words to mark on it.
 *
 * Only a term has words to mark. The office wrote it, so it is in the page's
 * text as written (the viewer's matcher folds case and spacing, and looks a page
 * either side). A detector's finding carries a masked sample, `AT61 •••• 1234`,
 * which is in no page's text: it opens at the page and marks nothing, because
 * the value itself is never stored (ADR-0086).
 */
export interface QuarantineFinding {
  page: number
  highlight: string | null
}

/** Every page a reason was found on, each as a finding to open. */
export function findingsOf(reason: QuarantineReason): QuarantineFinding[] {
  const highlight = reason.kind === 'term' && reason.term ? reason.term : null
  return (reason.pages ?? []).filter((page) => page >= 1).map((page) => ({ page, highlight }))
}

/** The finding a held document opens at: the first page of its first reason that has one. */
export function firstFinding(verdict: QuarantineVerdict | null): QuarantineFinding | null {
  for (const reason of verdict?.reasons ?? []) {
    const [first] = findingsOf(reason)
    if (first) return first
  }
  return null
}

/** A name-gate match, as a short phrase: `Ordner „Personalunterlagen“ enthält „Personal“`. */
export function describeNameMatch(match: NameMatch, t: Translator): string {
  return match.kind === 'file'
    ? t('screening.nameInFile', { term: match.term })
    : t('screening.nameInFolder', { term: match.term, segment: match.segment })
}

/**
 * What a browser upload held back by the name gate, as one sentence naming the
 * first three files and why (`files.errors.screenedOut`). `t` is the `files`
 * translator. Null when nothing was held back.
 */
export function describeScreenedOut(
  screenedOut: ReadonlyArray<{ file: { name: string }; matches: readonly NameMatch[] }>,
  t: Translator
): string | null {
  if (screenedOut.length === 0) return null
  return t('errors.screenedOut', {
    count: String(screenedOut.length),
    files: screenedOut
      .slice(0, 3)
      .map(({ file, matches }) =>
        t('errors.screenedOutFile', {
          name: file.name,
          reason: matches.map((match) => describeNameMatch(match, t)).join(', '),
        })
      )
      .join(', '),
  })
}
