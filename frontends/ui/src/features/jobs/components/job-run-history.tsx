'use client'

/**
 * One task's run history, newest first: a trigger badge (manual, scheduled,
 * delegated), the run's status, a timestamp and a link into the thread the run
 * wrote itself into.
 *
 * The status is the run's own (`TaskRunView.status`, the run lifecycle the
 * Tasks timeline shows), read from `GET /api/projects/[id]/runs?taskId=`.
 * This list used to read a submission-only word (`submitted`) that every run
 * the worker took carried whatever became of it, and joined the backend's job
 * list to find out; a failed run read „Übermittelt" whenever that join missed.
 * The run row has known how a run ended since the definitions/runs collapse
 * (migration 0086), so the row is now the one source, and the list polls
 * itself while a run is still going.
 *
 * There is one destination, the run's message in the thread that
 * commissioned it (ADR-0062). A run whose conversation this list cannot name
 * gets no link at all: the badge still says what became of it.
 */

import type { JSX } from 'react'
import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { AlertCircle, ArrowRight, CalendarClock, Hand, MessageSquare } from 'lucide-react'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge, type BadgeProps } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { Item, ItemActions, ItemContent, ItemList } from '@/components/ui/item'
import { Skeleton } from '@/components/ui/skeleton'
import { useLocale, useTranslations } from '@/i18n'
import { formatAbsoluteTime, formatRelativeTime } from '@/lib/format'
import { isActiveTaskRunStatus, type TaskRunStatus } from '@/lib/tasks/task-vocabulary'
import { listJobRuns, type JobRun } from '@/adapters/api/jobs-client'
import { taskThreadHref } from '@/features/tasks/lib/task-view'

interface JobRunHistoryProps {
  /** The project the task belongs to. */
  projectId: string
  jobId: string
}

const STATUS_VARIANT: Record<TaskRunStatus, NonNullable<BadgeProps['variant']>> = {
  queued: 'info',
  running: 'info',
  succeeded: 'success',
  failed: 'destructive',
  interrupted: 'secondary',
  skipped: 'warning',
  error: 'destructive',
}

const TRIGGER_ICON = { schedule: CalendarClock, manual: Hand, delegated: MessageSquare } as const

/** How often the list re-reads while a run is still going. */
const ACTIVE_POLL_MS = 10000

/** Runs older than this show their date, not "vor 12 Tagen": a date is what a person cross-checks. */
const ABSOLUTE_AFTER_MS = 7 * 24 * 60 * 60 * 1000

/** Relative for the recent past, the exact date once it stops being "just now". */
export function runTimeLabel(iso: string, locale: string, now: number = Date.now()): string {
  const at = new Date(iso).getTime()
  if (Number.isNaN(at) || now - at <= ABSOLUTE_AFTER_MS) return formatRelativeTime(iso, locale)
  return formatAbsoluteTime(iso, locale)
}

export function JobRunHistory({ projectId, jobId }: JobRunHistoryProps): JSX.Element {
  const t = useTranslations('jobs')
  const tTasks = useTranslations('tasks')
  const { locale } = useLocale()
  const [runs, setRuns] = useState<JobRun[] | null>(null)
  const [error, setError] = useState(false)

  const load = useCallback(() => {
    setRuns(null)
    setError(false)
    listJobRuns(projectId, jobId, { limit: 20 })
      .then(setRuns)
      .catch(() => setError(true))
  }, [projectId, jobId])

  useEffect(() => {
    load()
  }, [load])

  // While a run is going, re-read quietly until none is: the row's own status
  // is what changes, and it is the only thing this list shows.
  const anyActive = runs?.some((run) => isActiveTaskRunStatus(run.status)) ?? false
  useEffect(() => {
    if (!anyActive) return
    const timer = setTimeout(() => {
      listJobRuns(projectId, jobId, { limit: 20 })
        .then(setRuns)
        .catch(() => undefined)
    }, ACTIVE_POLL_MS)
    return () => clearTimeout(timer)
  }, [anyActive, runs, projectId, jobId])

  if (error) {
    return (
      <Alert variant="destructive" className="mt-1">
        <AlertCircle className="size-4" aria-hidden />
        <AlertDescription className="flex flex-col items-start gap-2">
          {t('history.loadError')}
          <Button variant="outline" size="sm" onClick={load}>
            {t('tryAgain')}
          </Button>
        </AlertDescription>
      </Alert>
    )
  }

  if (runs === null) {
    return (
      <div className="space-y-2 py-2" data-testid="job-run-history-loading">
        {Array.from({ length: 3 }).map((_, index) => (
          <Skeleton key={index} className="h-10 w-full rounded-lg" />
        ))}
      </div>
    )
  }

  if (runs.length === 0) {
    return <EmptyState variant="bare" title={t('history.empty')} />
  }

  return (
    <ItemList as="ul" className="animate-in fade-in-0 duration-base ease-out motion-reduce:animate-none">
      {runs.map((run) => {
        const TriggerIcon = TRIGGER_ICON[run.trigger]
        const link = taskThreadHref(projectId, run)
        const linkLabel = isActiveTaskRunStatus(run.status) ? t('history.viewProgress') : t('history.openChat')

        return (
          <Item as="li" key={run.id} className="flex-wrap justify-between py-2.5 max-sm:gap-y-0">
            {/* Two lines on a phone: what happened (badges, when, and the reason
                a run was skipped), then where to go. The row used to let the
                badges and the link share one non-wrapping line, and the link
                painted over the status. */}
            <ItemContent className="flex flex-wrap items-center gap-x-3 gap-y-1.5 max-sm:basis-full">
              <Badge variant="secondary" className="shrink-0 gap-1">
                <TriggerIcon className="size-3" aria-hidden />
                {t(`history.trigger.${run.trigger}`)}
              </Badge>
              <Badge variant={STATUS_VARIANT[run.status]} className="shrink-0" data-testid="run-status">
                {tTasks(`status.${run.status}`)}
              </Badge>
              <time
                dateTime={run.createdAt}
                className="text-xs text-muted-foreground whitespace-nowrap"
                title={formatAbsoluteTime(run.createdAt, locale)}
              >
                {runTimeLabel(run.createdAt, locale)}
              </time>
              {/* The reason is the part a person acts on, and a `title` does not
                  exist on a touch screen. */}
              {run.error && (
                <p className="text-muted-foreground basis-full text-xs" data-testid="run-detail">
                  {run.error}
                </p>
              )}
            </ItemContent>
            {link && (
              <ItemActions className="max-sm:w-full max-sm:justify-end">
                <Button asChild size="sm" variant="ghost" className="shrink-0 max-sm:-mr-2">
                  <Link href={link}>
                    {linkLabel}
                    <ArrowRight className="size-3.5" aria-hidden />
                  </Link>
                </Button>
              </ItemActions>
            )}
          </Item>
        )
      })}
    </ItemList>
  )
}
