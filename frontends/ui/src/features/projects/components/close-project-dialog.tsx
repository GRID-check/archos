'use client'

/**
 * Closing a project (ADR-0098), in three steps, each one question:
 *
 *   1. **Abschluss**: how did it end (completed, or not realized) and in which
 *      month. Both are the closing's own facts: the Abschluss is no longer a
 *      field of the Steckbrief that a running project could carry, it is the
 *      month this step names. Below them, what closing changes, said once.
 *   2. **Was bleibt**: the closing debrief (`closing-debrief.tsx`, passed as
 *      `children`): how Piloti finds the project again, and what the office
 *      keeps from its memory, while that memory can still be written.
 *   3. **Ausmisten** (ADR-0092): Piloti's proposal of what the finished project
 *      no longer needs, labelled as an AI proposal (EU AI Act Art. 50), every
 *      item pre-selected and deselectable. Only what is still selected goes to
 *      the Papierkorb, and only when the person confirms; then it closes.
 *
 * The outcome is chosen, never preselected, unless an earlier close of this
 * project named one: a default would nudge a late tidy-up towards the wrong
 * record. Steps two and three ask nothing that is required: „Weiter" is open,
 * and closing without removing anything is always one button. The proposal is
 * a paid model call (a POST), so it is asked for once the person moves past
 * the first step, not when the dialog opens; step two is its time to arrive.
 */

import { useEffect, useState, type JSX, type ReactNode } from 'react'
import { CircleCheck, CircleSlash, Sparkles } from 'lucide-react'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Chip } from '@/components/ui/chip'
import { ChoiceCard, ChoiceCardGroup } from '@/components/ui/choice-card'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field'
import { MonthInput } from '@/components/ui/month-input'
import { Stepper } from '@/components/ui/stepper'
import { useLocale, useTranslations } from '@/i18n'
import type { CleanupProposal } from '@/lib/projects/cleanup-types'
import { CLEANUP_PARTIALLY_UNDONE_REASON } from '@/lib/projects/cleanup-types'
import { currentMonth, isMonth } from '@/lib/projects/month'
import {
  abschlussBounds,
  abschlussProblem,
  defaultAbschluss,
  type ProjectLifecycleView,
  type ProjectOutcome,
} from '@/lib/projects/project-status'
import type { ClosingChoice } from '../lib/use-project-lifecycle'

export interface CloseProjectDialogProps {
  projectId: string
  /** Where the project stands: its Beginn bounds the Abschluss, and an earlier close suggests one. */
  lifecycle: Pick<ProjectLifecycleView, 'startedOn' | 'suggestedEndedOn' | 'suggestedOutcome'>
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Close the project as chosen; resolves true when it closed. */
  onClose: (choice: ClosingChoice) => Promise<boolean>
  /** The second step: the closing debrief. */
  children?: ReactNode
}

type Load = { state: 'loading' } | { state: 'ready'; proposal: CleanupProposal } | { state: 'failed' }

const STEPS = ['ending', 'keep', 'cleanup'] as const

export function CloseProjectDialog({
  projectId,
  lifecycle,
  open,
  onOpenChange,
  onClose,
  children,
}: CloseProjectDialogProps): JSX.Element {
  const t = useTranslations('projects')
  const { locale } = useLocale()
  const thisMonth = currentMonth()
  const [step, setStep] = useState(0)
  const [furthest, setFurthest] = useState(0)
  const [outcome, setOutcome] = useState<ProjectOutcome | null>(lifecycle.suggestedOutcome ?? null)
  const [endedOn, setEndedOn] = useState<string>(() => defaultAbschluss(lifecycle.suggestedEndedOn, lifecycle.startedOn, thisMonth))
  const [load, setLoad] = useState<Load>({ state: 'loading' })
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [pending, setPending] = useState(false)
  /** Why the last attempt failed: in general, or with files possibly left in these folders. */
  const [error, setError] = useState<false | { partialIn: string[] | null }>(false)

  useEffect(() => {
    if (!open) return
    setStep(0)
    setFurthest(0)
    setOutcome(lifecycle.suggestedOutcome ?? null)
    setEndedOn(defaultAbschluss(lifecycle.suggestedEndedOn, lifecycle.startedOn, currentMonth()))
    setLoad({ state: 'loading' })
    setError(false)
  }, [open, lifecycle.suggestedOutcome, lifecycle.suggestedEndedOn, lifecycle.startedOn])

  // The proposal, once per opening, as soon as the person is past step one.
  const askForProposal = open && furthest >= 1
  useEffect(() => {
    if (!askForProposal) return
    let cancelled = false
    fetch(`/api/projects/${projectId}/cleanup/proposal`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ locale: locale === 'en' ? 'en' : 'de' }),
    })
      .then(async (res) => {
        if (!res.ok) throw new Error(String(res.status))
        return (await res.json()) as CleanupProposal
      })
      .then((proposal) => {
        if (cancelled) return
        setLoad({ state: 'ready', proposal })
        setSelected(new Set(proposal.items.map((item) => item.documentId)))
      })
      .catch(() => {
        if (!cancelled) setLoad({ state: 'failed' })
      })
    return () => {
      cancelled = true
    }
  }, [askForProposal, projectId, locale])

  const proposal = load.state === 'ready' ? load.proposal : null
  const items = proposal?.items ?? []
  const bounds = abschlussBounds(lifecycle.startedOn, thisMonth)
  const abschlussError = abschlussProblem(endedOn, lifecycle.startedOn, thisMonth)
  const endingAnswered = outcome !== null && abschlussError === null
  const last = step === STEPS.length - 1

  const goTo = (index: number): void => {
    setStep(index)
    setFurthest((reached) => Math.max(reached, index))
  }

  const toggle = (id: string, on: boolean): void =>
    setSelected((current) => {
      const next = new Set(current)
      if (on) next.add(id)
      else next.delete(id)
      return next
    })

  const finish = async (remove: boolean): Promise<void> => {
    if (!outcome || abschlussError || !isMonth(endedOn)) {
      goTo(0)
      return
    }
    setPending(true)
    setError(false)
    try {
      if (remove && proposal && selected.size > 0) {
        const res = await fetch(`/api/projects/${projectId}/cleanup`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            documentIds: [...selected],
            proposedIds: items.map((item) => item.documentId),
            aiUsed: proposal.aiUsed,
          }),
        })
        if (!res.ok) {
          setError({ partialIn: partiallyUndoneIn(await res.json().catch(() => null)) })
          return
        }
        // Binned: what is left to retry, should the close itself fail, is the close.
        setSelected(new Set())
        setLoad({ state: 'ready', proposal: { ...proposal, items: [] } })
      }
      if (await onClose({ outcome, endedOn })) onOpenChange(false)
    } catch {
      setError({ partialIn: null })
    } finally {
      setPending(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t('lifecycle.closeDialog.title')}</DialogTitle>
          <DialogDescription>{t(`lifecycle.closeDialog.steps.${STEPS[step]}.description`)}</DialogDescription>
        </DialogHeader>

        <Stepper
          steps={STEPS.map((key) => ({ key, label: t(`lifecycle.closeDialog.steps.${key}.label`) }))}
          current={step}
          furthest={furthest}
          onSelect={goTo}
          label={t('lifecycle.closeDialog.stepsLabel')}
          progressLabel={t('lifecycle.closeDialog.stepProgress', { current: step + 1, total: STEPS.length })}
        />

        {step === 0 && (
          <div className="space-y-5 text-sm" data-testid="close-step-ending">
            <Field>
              <FieldLabel id="close-outcome-label">{t('lifecycle.closeDialog.outcome.label')}</FieldLabel>
              <ChoiceCardGroup
                value={outcome ?? ''}
                onValueChange={(value) => setOutcome(value === 'cancelled' ? 'cancelled' : 'completed')}
                aria-labelledby="close-outcome-label"
                className="sm:grid-cols-2"
              >
                <ChoiceCard
                  value="completed"
                  icon={CircleCheck}
                  label={t('lifecycle.outcome.completed')}
                  hint={t('lifecycle.closeDialog.outcome.completedHint')}
                />
                <ChoiceCard
                  value="cancelled"
                  icon={CircleSlash}
                  label={t('lifecycle.outcome.cancelled')}
                  hint={t('lifecycle.closeDialog.outcome.cancelledHint')}
                />
              </ChoiceCardGroup>
            </Field>
            <Field>
              <FieldLabel htmlFor="close-ended-on">{t('lifecycle.closeDialog.endedOn.label')}</FieldLabel>
              <MonthInput
                id="close-ended-on"
                className="max-w-sm"
                value={endedOn}
                onChange={setEndedOn}
                locale={locale}
                monthLabel={t('lifecycle.closeDialog.endedOn.label')}
                yearLabel={t('steckbrief.year')}
                fromYear={bounds.min ? Number(bounds.min.slice(0, 4)) : undefined}
                toYear={Number(bounds.max.slice(0, 4))}
                invalid={abschlussError !== null}
              />
              {abschlussError ? (
                <FieldError>{t(`lifecycle.closeDialog.endedOn.${abschlussError}`)}</FieldError>
              ) : (
                <FieldDescription>{t('lifecycle.closeDialog.endedOn.hint')}</FieldDescription>
              )}
            </Field>
            <div className="space-y-1.5">
              <p className="text-foreground font-medium">{t('lifecycle.closeDialog.changes.heading')}</p>
              <ul className="text-muted-foreground list-disc space-y-1 pl-5" data-testid="close-changes">
                <li>{t('lifecycle.closeDialog.changes.readOnly')}</li>
                <li>{t('lifecycle.closeDialog.changes.office')}</li>
                <li>{t('lifecycle.closeDialog.changes.stops')}</li>
                <li>{t('lifecycle.closeDialog.changes.reopen')}</li>
              </ul>
            </div>
          </div>
        )}

        {/* Kept mounted while another step shows: a half-written lesson and a
            reading of the documents (a paid call) survive „Zurück" and „Weiter". */}
        <div data-testid="close-step-keep" hidden={step !== 1}>
          {children}
        </div>

        {step === 2 && (
          <div className="space-y-3 text-sm" data-testid="close-step-cleanup">
            {load.state === 'loading' && <p data-testid="cleanup-loading">{t('cleanup.loading')}</p>}
            {load.state === 'failed' && <p className="text-muted-foreground">{t('cleanup.unavailable')}</p>}

            {proposal && (
              <>
                <Alert variant="info" data-testid="cleanup-notice">
                  <Sparkles aria-hidden />
                  <AlertDescription>{proposal.aiUsed ? t('cleanup.aiNotice') : t('cleanup.aiUnavailable')}</AlertDescription>
                </Alert>
                <p className="text-muted-foreground text-xs">{t('cleanup.considered', { count: proposal.considered })}</p>
                {items.length === 0 ? (
                  <p>{t('cleanup.none')}</p>
                ) : (
                  <ul className="max-h-80 space-y-2 overflow-y-auto" aria-label={t('lifecycle.closeDialog.steps.cleanup.label')}>
                    {items.map((item) => {
                      const id = `cleanup-${item.documentId}`
                      return (
                        <li key={item.documentId} className="flex items-start gap-3 rounded-lg border border-border p-2.5">
                          <Checkbox
                            id={id}
                            checked={selected.has(item.documentId)}
                            onCheckedChange={(checked) => toggle(item.documentId, checked === true)}
                            className="mt-0.5"
                          />
                          <label htmlFor={id} className="min-w-0 flex-1 space-y-0.5">
                            <span className="block truncate font-medium">{item.filename}</span>
                            {item.folderPath && <span className="text-muted-foreground block truncate text-xs">{item.folderPath}</span>}
                            <span className="text-muted-foreground block text-xs">
                              {item.aiReason ?? (item.rule ? t(`cleanup.rules.${item.rule}`) : '')}
                            </span>
                          </label>
                          {item.aiReason && (
                            <Chip variant="info" size="sm">
                              {t('cleanup.aiChip')}
                            </Chip>
                          )}
                        </li>
                      )
                    })}
                  </ul>
                )}
                {items.length > 0 && <p className="text-muted-foreground text-xs">{t('cleanup.binNote')}</p>}
              </>
            )}

            {error && (
              <p className="text-error text-sm" data-testid="cleanup-error">
                {error.partialIn ? t('cleanup.partial', { folders: error.partialIn.join('“, „') }) : t('cleanup.error')}
              </p>
            )}
          </div>
        )}

        <DialogFooter className="gap-2 sm:justify-between">
          {step === 0 ? (
            <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={pending}>
              {t('cleanup.cancel')}
            </Button>
          ) : (
            <Button variant="ghost" onClick={() => goTo(step - 1)} disabled={pending}>
              {t('lifecycle.closeDialog.back')}
            </Button>
          )}
          {!last ? (
            <Button onClick={() => goTo(step + 1)} disabled={step === 0 && !endingAnswered}>
              {t('lifecycle.closeDialog.next')}
            </Button>
          ) : (
            <div className="flex flex-wrap gap-2">
              {selected.size > 0 && proposal && items.length > 0 ? (
                <>
                  <Button variant="outline" onClick={() => finish(false)} disabled={pending}>
                    {t('cleanup.closeOnly')}
                  </Button>
                  <Button onClick={() => finish(true)} disabled={pending}>
                    {t('cleanup.confirm', { count: selected.size })}
                  </Button>
                </>
              ) : (
                <Button onClick={() => finish(false)} disabled={pending || load.state === 'loading'}>
                  {t('lifecycle.card.close')}
                </Button>
              )}
            </div>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** The folders a clean-out that could not be fully undone may have left files in; null for any other failure. */
function partiallyUndoneIn(body: unknown): string[] | null {
  if (!body || typeof body !== 'object') return null
  const details = (body as { details?: { reason?: unknown; folders?: unknown } }).details
  if (details?.reason !== CLEANUP_PARTIALLY_UNDONE_REASON || !Array.isArray(details.folders)) return null
  return details.folders.filter((name): name is string => typeof name === 'string')
}
