'use client'

/**
 * „Was Piloti tut": what Piloti is doing in this project, for the person
 * looking (`docs/architecture/piloti-activity.md`, „The view").
 *
 * Three sections over one read: Läuft gerade, Wartet auf Entscheidung,
 * Zuletzt. The organism reads through the typed client (`usePilotiActivity`),
 * draws what the server may show this reader, and writes only through the
 * clients that already own the two actions: taking a delegation back
 * (`updateAnnotation`) and stopping a run (`cancelRun`). Both sit behind a
 * confirmation, and after either the view reads again instead of editing its
 * copy: a 409 means someone else got there first, and the re-read says what is
 * true now.
 *
 * `fetcher` and `actions` are injection points for the dev preview and the
 * specs; the product passes neither.
 */

import type { JSX } from 'react'
import { useEffect, useRef, useState } from 'react'
import { AlertTriangle } from 'lucide-react'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { EmptyState } from '@/components/ui/empty-state'
import { Skeleton } from '@/components/ui/skeleton'
import { useTranslations } from '@/i18n'
import { updateAnnotation } from '@/lib/annotations/client'
import type {
  PilotiActivityResponse,
  RecentItem,
  RunningItem,
  RunningRun,
  RunningWake,
  WaitingItem,
} from '@/lib/piloti-activity/types'
import { cancelRun } from '@/lib/runs/run-view-client'
import { usePilotiActivity, type PilotiActivityFetcher } from '../hooks/use-piloti-activity'
import { activityCounts } from '../lib/activity-counts'
import { ActivitySection } from './activity-section'
import {
  ChangesRow,
  ProposalDecidedRow,
  ProposalRow,
  ProposedMarksRow,
  RunFinishedRow,
  RunRow,
  WakeEndedRow,
  WakeRow,
  type RowContext,
} from './activity-rows'

/** The two things a row can do. Each resolves when the server accepted it and rejects with the client's error otherwise. */
export interface PilotiActivityActions {
  takeBack: (wake: RunningWake) => Promise<unknown>
  stop: (projectId: string, run: RunningRun) => Promise<unknown>
}

const defaultActions: PilotiActivityActions = {
  takeBack: (wake) =>
    updateAnnotation(wake.document.id, wake.mark.id, {
      delegateToPiloti: false,
      expectedStatus: 'open',
    }),
  stop: (projectId, run) => cancelRun(projectId, run.id),
}

type Confirming = { kind: 'takeBack'; wake: RunningWake } | { kind: 'stop'; run: RunningRun }

type Notice = 'conflict' | 'actionError'

const DAY_MS = 24 * 60 * 60 * 1000

/** Both the annotation client and the run client throw an error carrying the HTTP status. */
function isConflict(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'status' in error && error.status === 409
}

export interface PilotiActivityProps {
  projectId: string
  /** Where the view reads from; stable across renders. Default: the typed client. */
  fetcher?: PilotiActivityFetcher
  /** Default: the annotation and run clients. */
  actions?: PilotiActivityActions
  /** Open the first take-back or stop confirmation once the rows are there (the dev preview shows the dialogs). */
  defaultConfirm?: 'takeBack' | 'stop'
}

export function PilotiActivity({
  projectId,
  fetcher,
  actions = defaultActions,
  defaultConfirm,
}: PilotiActivityProps): JSX.Element {
  const t = useTranslations('settings')
  const { activity, loading, failed, reload } = usePilotiActivity(projectId, fetcher)
  const [confirming, setConfirming] = useState<Confirming | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)

  const opened = useRef(false)
  useEffect(() => {
    if (!activity || !defaultConfirm || opened.current) return
    opened.current = true
    const wake = activity.running.items.find(
      (item): item is RunningWake => item.kind === 'wake' && item.canTakeBack
    )
    const run = activity.running.items.find(
      (item): item is RunningRun => item.kind === 'run' && item.canStop
    )
    if (defaultConfirm === 'takeBack' && wake) setConfirming({ kind: 'takeBack', wake })
    if (defaultConfirm === 'stop' && run) setConfirming({ kind: 'stop', run })
  }, [activity, defaultConfirm])

  const confirm = async (): Promise<void> => {
    if (!confirming) return
    try {
      await (confirming.kind === 'takeBack'
        ? actions.takeBack(confirming.wake)
        : actions.stop(projectId, confirming.run))
      setNotice(null)
    } catch (error) {
      setNotice(isConflict(error) ? 'conflict' : 'actionError')
    }
    await reload()
  }

  if (!activity) {
    return failed ? (
      <EmptyState
        icon={AlertTriangle}
        tone="warning"
        title={t('project.pilotiActivity.error')}
        action={
          <Button variant="outline" size="sm" onClick={() => void reload()}>
            {t('project.pilotiActivity.retry')}
          </Button>
        }
        data-testid="piloti-activity-error"
      />
    ) : (
      <div className="flex flex-col gap-3" aria-hidden data-testid="piloti-activity-loading">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
      </div>
    )
  }

  const ctx: RowContext = {
    projectId,
    viewerUserId: activity.viewerUserId,
    onTakeBack: (wake) => setConfirming({ kind: 'takeBack', wake }),
    onStop: (run) => setConfirming({ kind: 'stop', run }),
  }

  return (
    <div className="flex flex-col gap-6" aria-busy={loading} data-testid="piloti-activity">
      {notice && (
        <Alert variant="info" data-testid="piloti-activity-notice">
          <AlertDescription>{t(`project.pilotiActivity.${notice}`)}</AlertDescription>
        </Alert>
      )}
      {failed && (
        <Alert variant="warning" data-testid="piloti-activity-stale">
          <AlertTriangle />
          <AlertDescription className="flex flex-wrap items-center gap-3">
            {t('project.pilotiActivity.error')}
            <Button variant="outline" size="sm" onClick={() => void reload()}>
              {t('project.pilotiActivity.retry')}
            </Button>
          </AlertDescription>
        </Alert>
      )}
      <ActivitySections activity={activity} ctx={ctx} />
      {confirming && (
        <ConfirmDialog
          open
          onOpenChange={(open) => {
            if (!open) setConfirming(null)
          }}
          tone="warning"
          title={
            confirming.kind === 'takeBack'
              ? t('project.pilotiActivity.takeBackTitle', { number: confirming.wake.mark.number })
              : t('project.pilotiActivity.stopTitle')
          }
          description={
            confirming.kind === 'takeBack'
              ? t('project.pilotiActivity.takeBackConfirm', { number: confirming.wake.mark.number })
              : t('project.pilotiActivity.stopConfirm', { title: confirming.run.title })
          }
          confirmLabel={
            confirming.kind === 'takeBack'
              ? t('project.pilotiActivity.takeBack')
              : t('project.pilotiActivity.stopConfirmLabel')
          }
          cancelLabel={
            confirming.kind === 'takeBack'
              ? t('project.pilotiActivity.takeBackKeep')
              : t('project.pilotiActivity.stopKeep')
          }
          onConfirm={confirm}
          confirmTestId="piloti-activity-confirm"
        />
      )}
    </div>
  )
}

function RunningRow({ item, ctx }: { item: RunningItem; ctx: RowContext }): JSX.Element {
  return item.kind === 'wake' ? <WakeRow item={item} ctx={ctx} /> : <RunRow item={item} ctx={ctx} />
}

function WaitingRow({ item, ctx }: { item: WaitingItem; ctx: RowContext }): JSX.Element {
  return item.kind === 'proposal' ? (
    <ProposalRow item={item} ctx={ctx} />
  ) : (
    <ProposedMarksRow item={item} ctx={ctx} />
  )
}

function RecentRow({ item, ctx }: { item: RecentItem; ctx: RowContext }): JSX.Element {
  switch (item.kind) {
    case 'wake_ended':
      return <WakeEndedRow item={item} ctx={ctx} />
    case 'run_finished':
      return <RunFinishedRow item={item} ctx={ctx} />
    case 'changes':
      return <ChangesRow item={item} ctx={ctx} />
    case 'proposal_decided':
      return <ProposalDecidedRow item={item} ctx={ctx} />
  }
}

/** The three sections, or one empty state when Piloti has done nothing here at all. */
function ActivitySections({
  activity,
  ctx,
}: {
  activity: PilotiActivityResponse
  ctx: RowContext
}): JSX.Element {
  const t = useTranslations('settings')
  const counts = activityCounts(activity)
  const { running, waiting, recent } = activity

  if (running.items.length + waiting.items.length + recent.items.length === 0) {
    return (
      <EmptyState
        title={t('project.pilotiActivity.empty.all')}
        data-testid="piloti-activity-empty"
      />
    )
  }

  const days = Math.max(
    1,
    Math.round((Date.parse(activity.generatedAt) - Date.parse(recent.since)) / DAY_MS)
  )
  return (
    <>
      <ActivitySection
        data-testid="piloti-activity-running"
        title={t('project.pilotiActivity.sections.running')}
        count={counts.running}
        truncated={counts.runningTruncated}
        empty={{
          title: t('project.pilotiActivity.empty.running'),
          description: activity.capabilities.wakes
            ? t('project.pilotiActivity.empty.runningHint')
            : undefined,
        }}
      >
        {running.items.map((item) => (
          <RunningRow key={`${item.kind}-${item.id}`} item={item} ctx={ctx} />
        ))}
      </ActivitySection>
      <ActivitySection
        data-testid="piloti-activity-waiting"
        title={t('project.pilotiActivity.sections.waiting')}
        count={counts.waiting}
        truncated={counts.waitingTruncated}
        empty={{ title: t('project.pilotiActivity.empty.waiting') }}
      >
        {waiting.items.map((item) => (
          <WaitingRow key={`${item.kind}-${item.id}`} item={item} ctx={ctx} />
        ))}
      </ActivitySection>
      <ActivitySection
        data-testid="piloti-activity-recent"
        title={t('project.pilotiActivity.sections.recent')}
        count={recent.items.length}
        truncated={recent.truncated}
        empty={{ title: t('project.pilotiActivity.empty.recent', { days }) }}
      >
        {recent.items.map((item) => (
          <RecentRow key={`${item.kind}-${item.id}`} item={item} ctx={ctx} />
        ))}
      </ActivitySection>
    </>
  )
}
