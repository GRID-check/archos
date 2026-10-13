'use client'

/**
 * Why a file is held back (ADR-0086), and where: one chip per reason, and when
 * the surface can open the document, one button per page it was found on.
 *
 * A finding is shown the way a citation is: the page, and on it the words the
 * office listed, marked by the same viewer (`QuarantineFinding`). Before this the
 * preview of a held file said nothing at all, and the queue and the upload
 * summary said „Seiten 2, 7" as text the reader had to go and find by hand.
 *
 * The quarantine queue and the Files preview say it through this, so a reviewer
 * reads the same findings where they decide and where they look.
 */

import type { FC } from 'react'
import { ShieldAlert } from 'lucide-react'
import { Chip, ChipLabel } from '@/components/ui/chip'
import { useTranslations } from '@/i18n'
import { cn } from '@/lib/utils'
import {
  describeQuarantineReason,
  findingsOf,
  MORE_PAGES_MARK,
  parseQuarantine,
  quarantineReasonHead,
  type QuarantineFinding,
  type QuarantineVerdict,
} from '@/lib/upload-screening/quarantine'

export interface QuarantineFindingsProps {
  /** The stored verdict, `quarantined:{…}`. Anything else renders the sentence alone. */
  errorMessage?: string | null
  /** The verdict already read (the quarantine queue's rows carry it parsed). Wins over `errorMessage`. */
  verdict?: QuarantineVerdict | null
  /**
   * Open the document at a finding. Given, each page is a button; left unset
   * (a surface that cannot show the document), the pages are stated as text.
   */
  onShowFinding?: (finding: QuarantineFinding) => void
  /** The finding the document is open at, so its button can say so. */
  shownFinding?: QuarantineFinding | null
  /** Leave out the sentence that explains holding back, where the surface says it already. */
  withoutSentence?: boolean
  className?: string
  testId?: string
}

const sameFinding = (a: QuarantineFinding | null | undefined, b: QuarantineFinding): boolean =>
  !!a && a.page === b.page && a.highlight === b.highlight

export const QuarantineFindings: FC<QuarantineFindingsProps> = ({
  errorMessage,
  verdict: givenVerdict,
  onShowFinding,
  shownFinding,
  withoutSentence = false,
  className,
  testId = 'quarantine-findings',
}) => {
  const t = useTranslations('files')
  const verdict = givenVerdict !== undefined ? givenVerdict : parseQuarantine(errorMessage)
  const reasons = verdict?.reasons ?? []

  return (
    <div className={cn('flex flex-col gap-1.5', className)} data-testid={testId}>
      {reasons.length > 0 && (
        <ul className="flex flex-col gap-1" aria-label={t('screening.findingsLabel')}>
          {reasons.map((reason, index) => {
            const findings = onShowFinding ? findingsOf(reason) : []
            return (
              <li key={`${index}-${reason.kind}-${reason.term ?? ''}`} className="flex flex-wrap items-center gap-1">
                <Chip variant="warning" size="sm" title={describeQuarantineReason(reason, t)}>
                  <ShieldAlert aria-hidden />
                  <ChipLabel>{findings.length > 0 ? quarantineReasonHead(reason, t) : describeQuarantineReason(reason, t)}</ChipLabel>
                </Chip>
                {findings.map((finding) => {
                  const shown = sameFinding(shownFinding, finding)
                  return (
                    <Chip key={finding.page} asChild interactive variant={shown ? 'warning' : 'outline'} size="sm">
                      <button
                        type="button"
                        onClick={() => onShowFinding?.(finding)}
                        aria-pressed={shown}
                        aria-label={t('screening.showFinding', { page: finding.page })}
                        data-testid={`${testId}-page-${finding.page}`}
                      >
                        {t('screening.findingPage', { page: finding.page })}
                      </button>
                    </Chip>
                  )
                })}
                {/* The job listed only some of the pages (`pages_truncated`). As
                    text the phrase above ends in „…" already. */}
                {findings.length > 0 && reason.pages_truncated && (
                  <span
                    className="text-muted-foreground px-0.5 text-xs"
                    title={t('screening.morePages')}
                    data-testid={`${testId}-more-pages`}
                  >
                    <span aria-hidden>{MORE_PAGES_MARK}</span>
                    <span className="sr-only">{t('screening.morePages')}</span>
                  </span>
                )}
              </li>
            )
          })}
        </ul>
      )}
      {verdict?.checked === 'partial' && (
        <p className="text-muted-foreground text-xs leading-snug">{t('screening.partial')}</p>
      )}
      {!withoutSentence && (
        <p className="text-muted-foreground text-xs leading-snug">{t('ingestFailure.quarantined')}</p>
      )}
    </div>
  )
}
