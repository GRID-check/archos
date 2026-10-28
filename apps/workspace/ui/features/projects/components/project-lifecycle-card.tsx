'use client'

/**
 * The project's lifecycle on its Overview (ADR-0098), for whoever holds
 * `project:manage`: where it stands, what that means, and the moves it has.
 *
 *   Aktiv ⇄ Ruhend → Abgeschlossen → (wieder öffnen) Aktiv
 *
 * The track draws the three states with the current one marked, so the model
 * is visible rather than implied by whichever button happens to show. Below
 * it, one line on what the current state means, and the moves from it: pause
 * or close an active project, resume or close a paused one, reopen a closed
 * one. A closed project says how it ended and its Abschluss.
 *
 * The moves themselves, and their dialogs, are `useProjectLifecycle`, which the
 * hero's menu and the banner share.
 */

import type { JSX } from 'react'
import { Lock, LockOpen, PauseCircle, PlayCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Chip } from '@/components/ui/chip'
import { RaisedCard, RaisedCardBody } from '@/components/ui/raised-card'
import { ProjectStatusChip } from '@/components/projects/project-status'
import { useLocale, useTranslations } from '@/i18n'
import { projectsCopy } from '@/i18n/namespaces/projects'
import type { ProjectProfile } from '@/lib/project-profile/types'
import { monthToDate } from '@/lib/projects/month'
import { PROJECT_STATUSES, type ProjectLifecycleView } from '@/lib/projects/project-status'
import { useProjectLifecycle } from '../lib/use-project-lifecycle'

export interface ProjectLifecycleCardProps {
  projectId: string
  lifecycle: ProjectLifecycleView
  /** The profile, for the closing debrief's fingerprint. */
  profile?: ProjectProfile | null
  /** Whether the closer may confirm decisions and record a lesson in the debrief. */
  canWriteMemory?: boolean
}

export function ProjectLifecycleCard({
  projectId,
  lifecycle,
  profile = null,
  canWriteMemory = false,
}: ProjectLifecycleCardProps): JSX.Element {
  const t = useTranslations(projectsCopy)
  const { locale } = useLocale()
  const controls = useProjectLifecycle({ projectId, lifecycle, profile, canWriteMemory })
  const { status } = lifecycle

  const day = (iso: string | null): string | null =>
    iso ? new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(iso)) : null
  const month = lifecycle.endedOn
    ? new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(
        new Date(`${monthToDate(lifecycle.endedOn)}T00:00:00Z`)
      )
    : null

  const meaning =
    status === 'closed'
      ? t('lifecycle.card.closedDescription')
      : status === 'paused'
        ? t('lifecycle.card.pausedDescription')
        : t('lifecycle.card.activeDescription')

  return (
    <RaisedCard aria-label={t('lifecycle.card.heading')} data-testid="project-lifecycle-card">
      <RaisedCardBody className="space-y-4 p-6">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-foreground text-sm font-semibold">{t('lifecycle.card.heading')}</h2>
          <ProjectStatusChip status={status} outcome={lifecycle.closedOutcome} size="sm" />
        </div>

        <LifecycleTrack current={status} />

        <div className="space-y-1 text-sm">
          {status === 'closed' && (
            <p className="text-foreground" data-testid="lifecycle-closed-facts">
              {t('lifecycle.card.closedFacts', {
                outcome: t(`lifecycle.outcome.${lifecycle.closedOutcome ?? 'completed'}`),
                month: month ?? '—',
              })}
            </p>
          )}
          {status === 'closed' && day(lifecycle.closedAt) && (
            <p className="text-muted-foreground">{t('lifecycle.card.closedOn', { date: day(lifecycle.closedAt) ?? '' })}</p>
          )}
          {status === 'paused' && day(lifecycle.pausedAt) && (
            <p className="text-foreground">{t('lifecycle.card.pausedOn', { date: day(lifecycle.pausedAt) ?? '' })}</p>
          )}
          <p className="text-muted-foreground max-w-2xl leading-relaxed">{meaning}</p>
        </div>

        <div className="flex flex-wrap gap-2">
          {status === 'active' && (
            <Button variant="outline" onClick={controls.pause} disabled={controls.pending}>
              <PauseCircle className="size-4" aria-hidden />
              {t('lifecycle.card.pause')}
            </Button>
          )}
          {status === 'paused' && (
            <Button onClick={controls.resume} disabled={controls.pending}>
              <PlayCircle className="size-4" aria-hidden />
              {t('lifecycle.card.resume')}
            </Button>
          )}
          {status !== 'closed' && (
            <Button variant="outline" onClick={controls.requestClose} disabled={controls.pending}>
              <Lock className="size-4" aria-hidden />
              {t('lifecycle.card.close')}
            </Button>
          )}
          {status === 'closed' && (
            <Button variant="outline" onClick={controls.requestReopen} disabled={controls.pending}>
              <LockOpen className="size-4" aria-hidden />
              {t('lifecycle.card.reopen')}
            </Button>
          )}
        </div>
        {status !== 'closed' && <p className="text-muted-foreground text-xs leading-relaxed">{t('lifecycle.card.whichOne')}</p>}
        {controls.dialogs}
      </RaisedCardBody>
    </RaisedCard>
  )
}

/** The three states in a row, the current one marked: the model, drawn. */
function LifecycleTrack({ current }: { current: ProjectLifecycleView['status'] }): JSX.Element {
  const t = useTranslations(projectsCopy)
  return (
    <ol className="flex flex-wrap items-center gap-1.5 text-xs" aria-label={t('lifecycle.card.track')}>
      {PROJECT_STATUSES.map((status, index) => (
        <li key={status} className="flex items-center gap-1.5">
          {index > 0 && (
            <span aria-hidden className="text-muted-foreground">
              {index === 1 ? '⇄' : '→'}
            </span>
          )}
          <Chip variant={status === current ? 'default' : 'outline'} size="sm" aria-current={status === current ? 'step' : undefined}>
            {t(`card.status.${status}`)}
          </Chip>
        </li>
      ))}
    </ol>
  )
}
