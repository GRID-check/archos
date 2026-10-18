'use client'

import type { JSX } from 'react'
import { useState } from 'react'
import Link from 'next/link'
import { CheckCircle2 } from 'lucide-react'
import { BusyButton } from '@/components/ui/busy-button'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { EmptyStateDisc } from '@/components/ui/empty-state'
import { useTranslations } from '@/i18n'
import { cn } from '@/lib/utils'
import type { ClosingIntent, IntakeView } from '@/lib/project-intake/types'

/** `2019-03` as the office writes a month: `03/2019`. */
export const formatMonth = (month: string): string => `${month.slice(5, 7)}/${month.slice(0, 4)}`

function usePeriod(closing: ClosingIntent): string {
  const t = useTranslations('projectIntake')
  return closing.startedOn
    ? t('complete.period', { from: formatMonth(closing.startedOn), to: formatMonth(closing.endedOn) })
    : t('complete.periodEnd', { to: formatMonth(closing.endedOn) })
}

/** What still waits for a decision: the contradictions and the decisive Rückfragen the page lists. */
function openItems(view: IntakeView): { contradictions: number; questions: number } {
  return { contradictions: view.contradictions.length, questions: view.questions.length }
}

/** Nothing for a person to look at yet: no value, no contradiction, no question. */
function nothingToReview(view: IntakeView): boolean {
  const { contradictions, questions } = openItems(view)
  return view.counts.suggested === 0 && contradictions === 0 && questions === 0
}

/**
 * Erfassung abschließen, at the foot of the review. It is the ink primary only
 * when the review is ready and nothing is open; with a contradiction or a
 * decisive Rückfrage still waiting it is a secondary button and the line beside
 * it says what is open, and that finishing anyway is allowed. For a closing
 * intent the copy says what finishing does: it closes the project with its
 * outcome and period, so the button asks first. It stays away while there is
 * nothing to finish: waiting for documents, or reading with nothing found yet.
 */
export function CompleteFooter({
  view,
  busy,
  onComplete,
}: {
  view: IntakeView
  busy: boolean
  onComplete: () => Promise<boolean>
}): JSX.Element | null {
  if (view.status === 'completed' || !view.canComplete) return null
  if (view.status === 'waiting') return null
  if (view.status !== 'ready' && nothingToReview(view)) return null
  return <CompleteAction view={view} busy={busy} onComplete={onComplete} />
}

/**
 * The finished state, where the page's attention goes once nothing is left to
 * decide: what happened, and the way on to the project's overview.
 */
export function CompletedNote({ view }: { view: IntakeView }): JSX.Element {
  const t = useTranslations('projectIntake')
  return (
    <section
      role="status"
      className="border-border bg-card flex flex-col gap-4 rounded-lg border p-5 shadow-xs sm:flex-row sm:items-center sm:justify-between"
      data-testid="intake-completed"
    >
      <div className="flex min-w-0 items-start gap-3">
        <EmptyStateDisc icon={CheckCircle2} size="sm" />
        <div className="min-w-0 space-y-1">
          <p className="text-sm font-semibold">
            {view.mode === 'closing' ? t('complete.doneClosing') : t('complete.done')}
          </p>
          <p className="text-muted-foreground text-sm">{t('complete.doneHint')}</p>
        </div>
      </div>
      <Button asChild className="sm:shrink-0">
        <Link href={`/app/projects/${view.projectId}/settings`}>{t('complete.openProject')}</Link>
      </Button>
    </section>
  )
}

function CompleteAction({
  view,
  busy,
  onComplete,
}: {
  view: IntakeView
  busy: boolean
  onComplete: () => Promise<boolean>
}): JSX.Element {
  const t = useTranslations('projectIntake')
  const [asking, setAsking] = useState(false)
  const closing = view.closing
  const { contradictions, questions } = openItems(view)
  const open = [
    contradictions > 0 ? t('counts.contradictions', { count: contradictions }) : null,
    questions > 0 ? t('counts.questions', { count: questions }) : null,
  ].filter((part): part is string => part !== null)
  // The ink primary says „this is the next thing to do": only true when nothing
  // is open and the reading is done.
  const primary = open.length === 0 && view.status === 'ready'

  return (
    <div
      className={cn(
        'border-border bg-card flex flex-col gap-3 rounded-lg border p-4 sm:flex-row sm:items-center sm:justify-between',
        // Ready and nothing open: finishing is the next thing to do, so on a
        // phone it stays on screen instead of waiting after the review, the
        // filing and the derivations. It scrolls into its own place at the
        // end. The bottom padding follows the shell's published inset (the
        // phone tab bar, standing under this page, owns the home indicator's),
        // and falls back to the device's own. While something is open it is a secondary button and does not
        // float over the work that is still to do.
        primary &&
          'max-sm:sticky max-sm:bottom-0 max-sm:z-20 max-sm:-mx-4 max-sm:rounded-none max-sm:border-x-0 max-sm:border-b-0 max-sm:bg-background/90 max-sm:px-4 max-sm:pb-[max(0.75rem,var(--shell-inset-bottom,env(safe-area-inset-bottom)))] max-sm:pt-3 max-sm:backdrop-blur-md',
      )}
      data-testid="intake-complete"
      data-primary={primary || undefined}
    >
      <div className={cn('max-w-prose space-y-1 text-sm', primary && 'max-sm:hidden')}>
        {open.length > 0 && (
          <p className="text-foreground" data-testid="intake-open">
            {t('complete.hintOpen', { open: open.join(', ') })}
          </p>
        )}
        {/* What finishing does is spelled out again in the confirmation, so the
            floating bar spares the phone the paragraph (the block above is
            hidden there while the bar floats). */}
        <p className="text-muted-foreground">{closing ? <ClosingHint closing={closing} /> : t('complete.hint')}</p>
      </div>
      <BusyButton
        type="button"
        variant={primary ? 'default' : 'secondary'}
        className="max-sm:w-full sm:shrink-0"
        blocked={busy}
        busyLabel={t('busy.complete')}
        onClick={() => setAsking(true)}
      >
        {t('complete.button')}
      </BusyButton>
      <ConfirmDialog
        open={asking}
        onOpenChange={setAsking}
        title={t('complete.confirmTitle')}
        description={
          closing ? (
            <ClosingHint closing={closing} confirm />
          ) : (
            t('complete.confirmDescription')
          )
        }
        confirmLabel={t('complete.confirm')}
        cancelLabel={t('complete.cancel')}
        tone={closing ? 'warning' : 'default'}
        pending={busy}
        onConfirm={async () => {
          if (await onComplete()) setAsking(false)
        }}
      />
    </div>
  )
}

function ClosingHint({ closing, confirm = false }: { closing: ClosingIntent; confirm?: boolean }): JSX.Element {
  const t = useTranslations('projectIntake')
  const tProjects = useTranslations('projects')
  const period = usePeriod(closing)
  const outcome = tProjects(`lifecycle.outcome.${closing.outcome}`)
  return (
    <>
      {confirm
        ? t('complete.confirmDescriptionClosing', { outcome, period })
        : t('complete.hintClosing', { outcome, period })}
    </>
  )
}
