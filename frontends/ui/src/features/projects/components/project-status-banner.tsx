'use client'

/**
 * The line every page of a project that is not active opens with (ADR-0098,
 * ADR-0090), saying what its state means where the reader meets it, and the
 * one move out of it for whoever may make it.
 *
 *   - **Paused**: since when, that it stays editable, that its scheduled tasks
 *     wait. „Fortsetzen".
 *   - **Closed**: since when and how it ended, read-only, chat still open.
 *     Someone who reads the project only because it is closed is told why they
 *     see it, and that folders with their own access list stay hidden from
 *     them. „Wieder öffnen".
 *
 * Renders nothing for an active project, so the layout mounts it everywhere.
 */

import type { JSX } from 'react'
import { Lock, LockOpen, PauseCircle, PlayCircle } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { useLocale, useTranslations } from '@/i18n'
import type { ProjectLifecycleView } from '@/lib/projects/project-status'
import { useCurrentProject } from '../lib/current-project'
import { useProjectLifecycle } from '../lib/use-project-lifecycle'

export function ProjectStatusBanner(): JSX.Element | null {
  const project = useCurrentProject()
  if (!project || project.status === 'active') return null
  const lifecycle: ProjectLifecycleView = project.lifecycle ?? {
    status: project.status,
    pausedAt: null,
    closedAt: project.closedAt,
    closedOutcome: null,
    endedOn: null,
    startedOn: null,
    suggestedEndedOn: null,
  }
  return (
    <StatusBanner
      projectId={project.id}
      lifecycle={lifecycle}
      readsBecauseClosed={project.readsBecauseClosed}
      canChangeStatus={project.canChangeStatus ?? false}
    />
  )
}

function StatusBanner({
  projectId,
  lifecycle,
  readsBecauseClosed,
  canChangeStatus,
}: {
  projectId: string
  lifecycle: ProjectLifecycleView
  readsBecauseClosed: boolean
  canChangeStatus: boolean
}): JSX.Element {
  const t = useTranslations('projects')
  const { locale } = useLocale()
  const controls = useProjectLifecycle({ projectId, lifecycle })
  const paused = lifecycle.status === 'paused'

  const since = paused ? lifecycle.pausedAt : lifecycle.closedAt
  const at = since ? new Date(since) : null
  const date =
    at && !Number.isNaN(at.getTime())
      ? new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'long', year: 'numeric' }).format(at)
      : null

  const sentences = paused
    ? [date ? t('lifecycle.banner.pausedOn', { date }) : '', t('lifecycle.banner.pausedBody')]
    : [
        date ? t('lifecycle.banner.closedOn', { date }) : '',
        lifecycle.closedOutcome === 'cancelled' ? t('lifecycle.banner.cancelled') : '',
        t('lifecycle.banner.body'),
        readsBecauseClosed ? t('lifecycle.banner.outsider') : '',
      ]

  return (
    <>
      <Alert
        variant="info"
        className="rounded-none border-x-0 border-t-0 px-4 py-2.5 md:px-8"
        data-testid={paused ? 'paused-project-banner' : 'closed-project-banner'}
      >
        {paused ? <PauseCircle aria-hidden /> : <Lock aria-hidden />}
        <AlertTitle>{paused ? t('lifecycle.banner.pausedTitle') : t('lifecycle.banner.title')}</AlertTitle>
        <AlertDescription className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <span>{sentences.filter(Boolean).join(' ')}</span>
          {canChangeStatus && (
            <Button
              size="sm"
              variant="outline"
              disabled={controls.pending}
              onClick={paused ? controls.resume : controls.requestReopen}
            >
              {paused ? <PlayCircle className="size-4" aria-hidden /> : <LockOpen className="size-4" aria-hidden />}
              {paused ? t('lifecycle.card.resume') : t('lifecycle.card.reopen')}
            </Button>
          )}
        </AlertDescription>
      </Alert>
      {canChangeStatus && controls.dialogs}
    </>
  )
}
