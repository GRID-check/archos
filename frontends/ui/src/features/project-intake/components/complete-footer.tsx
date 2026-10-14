'use client'

import type { JSX } from 'react'
import { useState } from 'react'
import Link from 'next/link'
import { CheckCircle2 } from 'lucide-react'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { useTranslations } from '@/i18n'
import type { ClosingIntent, IntakeView } from '@/lib/project-intake/types'

/** `2019-03` as the office writes a month: `03/2019`. */
export const formatMonth = (month: string): string => `${month.slice(5, 7)}/${month.slice(0, 4)}`

function usePeriod(closing: ClosingIntent): string {
  const t = useTranslations('projectIntake')
  return closing.startedOn
    ? t('complete.period', { from: formatMonth(closing.startedOn), to: formatMonth(closing.endedOn) })
    : t('complete.periodEnd', { to: formatMonth(closing.endedOn) })
}

/**
 * Erfassung abschließen. For a closing intent the copy says what it does: it
 * closes the project with its outcome and period, so the button asks first.
 * Once finished the page says so and points to the project.
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
  if (view.status === 'completed') return <CompletedNote view={view} />
  if (!view.canComplete) return null
  return <CompleteAction view={view} busy={busy} onComplete={onComplete} />
}

function CompletedNote({ view }: { view: IntakeView }): JSX.Element {
  const t = useTranslations('projectIntake')
  return (
    <Alert variant="success" role="status" data-testid="intake-completed">
      <CheckCircle2 aria-hidden />
      <AlertDescription className="text-current">
        <p>{view.mode === 'closing' ? t('complete.doneClosing') : t('complete.done')}</p>
        <Button asChild size="sm" variant="outline" className="mt-1">
          <Link href={`/app/projects/${view.projectId}`}>{t('complete.openProject')}</Link>
        </Button>
      </AlertDescription>
    </Alert>
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
  const hint = closing ? <ClosingHint closing={closing} /> : t('complete.hint')

  return (
    <div
      className="border-border bg-card flex flex-col gap-3 rounded-lg border p-4 sm:flex-row sm:items-center sm:justify-between"
      data-testid="intake-complete"
    >
      <p className="text-muted-foreground max-w-prose text-sm">{hint}</p>
      <Button type="button" disabled={busy} onClick={() => setAsking(true)}>
        {t('complete.button')}
      </Button>
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
