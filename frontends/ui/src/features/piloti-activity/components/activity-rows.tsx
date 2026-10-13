'use client'

/**
 * The eight kinds of row „Was Piloti tut" shows, one component each.
 *
 * Every row says what happened, where, and for whom („für Sie" when the
 * viewer is the person Piloti worked for). The words come from the existing
 * vocabularies: `tasks.kind`/`tasks.status` for runs, `files.annotations.kinds`
 * for a mark's kind. A failed wake is worded by `reasonKind`; the stored
 * reason is written for the log and appears only as a tooltip.
 *
 * Each row offers a link to where the work is, and the actions only when the
 * server said this reader may (`canTakeBack`, `canStop`).
 */

import type { JSX, ReactNode } from 'react'
import Link from 'next/link'
import { Clock, FileText, History, Sparkles, type LucideIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Chip, type ChipProps } from '@/components/ui/chip'
import { PilotiGlyph } from '@/components/ui/piloti-glyph'
import { Spinner } from '@/components/ui/spinner'
import { useTranslations } from '@/i18n'
import type {
  ActivityMark,
  ActivityPerson,
  ActivityTarget,
  RecentChanges,
  RecentProposal,
  RecentRun,
  RecentWake,
  RunningRun,
  RunningWake,
  WaitingProposal,
  WaitingProposedMarks,
} from '@/lib/piloti-activity/types'
import { activityTargetHref } from '../lib/activity-target'
import { ActivityRow } from './activity-row'

/** What a row needs from the view around it. */
export interface RowContext {
  projectId: string
  viewerUserId: string
  /** Ask to take a delegation back (opens the confirmation). */
  onTakeBack: (wake: RunningWake) => void
  /** Ask to stop a run (opens the confirmation). */
  onStop: (run: RunningRun) => void
}

const SEPARATOR = ' · '

/** The words rows are made of, bound to the three dictionaries they draw on. */
function useRowText(viewerUserId: string) {
  const t = useTranslations('settings')
  const tFiles = useTranslations('files')
  const tTasks = useTranslations('tasks')

  const forPerson = (person: ActivityPerson): string =>
    person.userId === viewerUserId
      ? t('project.pilotiActivity.forYou')
      : t('project.pilotiActivity.forPerson', {
          name: person.name ?? t('project.pilotiActivity.someone'),
        })
  const markLabel = (mark: ActivityMark): string =>
    [
      t('project.pilotiActivity.mark', { number: mark.number }),
      tFiles(`annotations.kinds.${mark.kind}`),
      ...(mark.excerpt ? [mark.excerpt] : []),
    ].join(SEPARATOR)
  const linkLabel = (target: ActivityTarget): string => {
    if (target.kind === 'review') return t('project.pilotiActivity.openMark')
    if (target.kind === 'task') return t('project.pilotiActivity.openTask')
    return t('project.pilotiActivity.openTurn')
  }
  return { t, tFiles, tTasks, forPerson, markLabel, linkLabel }
}

function TargetLink({
  projectId,
  target,
  label,
}: {
  projectId: string
  target: ActivityTarget
  label: string
}): JSX.Element {
  return (
    <Button asChild variant="ghost" size="sm">
      <Link href={activityTargetHref(projectId, target)}>{label}</Link>
    </Button>
  )
}

function RunMark({ icon: Icon }: { icon: LucideIcon }): JSX.Element {
  return <Icon className="text-muted-foreground size-4" aria-hidden />
}

type ChipVariant = NonNullable<ChipProps['variant']>

function StateChip({
  variant = 'muted',
  title,
  children,
}: {
  variant?: ChipVariant
  title?: string
  children: ReactNode
}): JSX.Element {
  return (
    <Chip variant={variant} size="sm" title={title}>
      {children}
    </Chip>
  )
}

// ---------------------------------------------------------------------------
// Läuft gerade
// ---------------------------------------------------------------------------

export function WakeRow({ item, ctx }: { item: RunningWake; ctx: RowContext }): JSX.Element {
  const { t, forPerson, markLabel, linkLabel } = useRowText(ctx.viewerUserId)
  return (
    <ActivityRow
      data-testid={`activity-wake-${item.id}`}
      media={<PilotiGlyph working={item.status === 'started'} />}
      title={markLabel(item.mark)}
      description={[
        item.document.name,
        t(`project.pilotiActivity.wake.trigger.${item.trigger}`),
        forPerson(item.forPerson),
      ].join(SEPARATOR)}
      state={
        <StateChip variant={item.status === 'started' ? 'info' : 'muted'}>
          {t(`project.pilotiActivity.wake.${item.status}`)}
        </StateChip>
      }
      at={item.at}
      actions={
        <>
          {item.canTakeBack && (
            <Button variant="outline" size="sm" onClick={() => ctx.onTakeBack(item)}>
              {t('project.pilotiActivity.takeBack')}
            </Button>
          )}
          <TargetLink
            projectId={ctx.projectId}
            target={item.target}
            label={linkLabel(item.target)}
          />
          {item.turn && (
            <TargetLink projectId={ctx.projectId} target={item.turn} label={linkLabel(item.turn)} />
          )}
        </>
      }
    />
  )
}

export function RunRow({ item, ctx }: { item: RunningRun; ctx: RowContext }): JSX.Element {
  const { t, tTasks, forPerson, linkLabel } = useRowText(ctx.viewerUserId)
  return (
    <ActivityRow
      data-testid={`activity-run-${item.id}`}
      media={
        item.status === 'running' ? (
          <Spinner size="xs" aria-hidden className="text-muted-foreground" />
        ) : (
          <RunMark icon={Clock} />
        )
      }
      title={item.title}
      description={[tTasks(`kind.${item.taskKind}`), forPerson(item.forPerson)].join(SEPARATOR)}
      state={
        <StateChip variant={item.status === 'running' ? 'info' : 'muted'}>
          {tTasks(`status.${item.status}`)}
        </StateChip>
      }
      at={item.at}
      actions={
        <>
          {item.canStop && (
            <Button variant="outline" size="sm" onClick={() => ctx.onStop(item)}>
              {t('project.pilotiActivity.stop')}
            </Button>
          )}
          {item.target && (
            <TargetLink
              projectId={ctx.projectId}
              target={item.target}
              label={linkLabel(item.target)}
            />
          )}
        </>
      }
    />
  )
}

// ---------------------------------------------------------------------------
// Wartet auf Entscheidung
// ---------------------------------------------------------------------------

export function ProposalRow({
  item,
  ctx,
}: {
  item: WaitingProposal
  ctx: RowContext
}): JSX.Element {
  const { t, forPerson, linkLabel } = useRowText(ctx.viewerUserId)
  return (
    <ActivityRow
      data-testid={`activity-proposal-${item.id}`}
      media={<PilotiGlyph />}
      title={item.summary}
      description={[
        t(`project.pilotiActivity.proposal.${item.proposalKind}`),
        forPerson(item.forPerson),
      ].join(SEPARATOR)}
      state={
        item.canDecide ? (
          <StateChip variant="default">{t('project.pilotiActivity.proposal.yours')}</StateChip>
        ) : null
      }
      at={item.at}
      actions={
        <TargetLink projectId={ctx.projectId} target={item.target} label={linkLabel(item.target)} />
      }
    />
  )
}

export function ProposedMarksRow({
  item,
  ctx,
}: {
  item: WaitingProposedMarks
  ctx: RowContext
}): JSX.Element {
  const { t, forPerson, markLabel, linkLabel } = useRowText(ctx.viewerUserId)
  const people = [
    ...new Map(item.marks.map((mark) => [mark.forPerson.userId, mark.forPerson])).values(),
  ].map(forPerson)
  const unseen = item.count - item.marks.length
  return (
    <ActivityRow
      data-testid={`activity-proposed-marks-${item.id}`}
      media={<PilotiGlyph />}
      title={t('project.pilotiActivity.proposedMarks', {
        count: item.count,
        document: item.document.name,
      })}
      description={people.join(', ')}
      details={[
        ...item.marks.map(markLabel),
        ...(unseen > 0 ? [t('project.pilotiActivity.proposedMarksMore', { count: unseen })] : []),
      ]}
      at={item.at}
      actions={
        <TargetLink projectId={ctx.projectId} target={item.target} label={linkLabel(item.target)} />
      }
    />
  )
}

// ---------------------------------------------------------------------------
// Zuletzt
// ---------------------------------------------------------------------------

const WAKE_END_VARIANTS: Record<RecentWake['status'], ChipVariant> = {
  answered: 'success',
  stopped: 'muted',
  failed: 'destructive',
  refused: 'warning',
}

export function WakeEndedRow({ item, ctx }: { item: RecentWake; ctx: RowContext }): JSX.Element {
  const { t, forPerson, markLabel, linkLabel } = useRowText(ctx.viewerUserId)
  // A failed or refused wake is worded by its class; the class is null only
  // for a row from a server that did not classify it, which gets the plain
  // status word. The stored reason is for the log: a tooltip, never the text.
  const word = item.reasonKind
    ? t(`project.pilotiActivity.wake.reasonKind.${item.reasonKind}`)
    : t(`project.pilotiActivity.wake.${item.status}`)
  return (
    <ActivityRow
      data-testid={`activity-wake-ended-${item.id}`}
      media={<PilotiGlyph />}
      title={markLabel(item.mark)}
      description={[
        item.document.name,
        t(`project.pilotiActivity.wake.trigger.${item.trigger}`),
        forPerson(item.forPerson),
      ].join(SEPARATOR)}
      state={
        <StateChip variant={WAKE_END_VARIANTS[item.status]} title={item.reason ?? undefined}>
          {word}
        </StateChip>
      }
      at={item.at}
      actions={
        <>
          <TargetLink
            projectId={ctx.projectId}
            target={item.target}
            label={linkLabel(item.target)}
          />
          {item.turn && (
            <TargetLink projectId={ctx.projectId} target={item.turn} label={linkLabel(item.turn)} />
          )}
        </>
      }
    />
  )
}

const RUN_END_VARIANTS: Record<RecentRun['status'], ChipVariant> = {
  succeeded: 'success',
  failed: 'destructive',
  error: 'destructive',
  interrupted: 'muted',
  skipped: 'muted',
}

export function RunFinishedRow({ item, ctx }: { item: RecentRun; ctx: RowContext }): JSX.Element {
  const { t, tTasks, forPerson, linkLabel } = useRowText(ctx.viewerUserId)
  const details = [
    ...(item.filedDocument
      ? [t('project.pilotiActivity.run.filed', { document: item.filedDocument.name })]
      : []),
    ...(item.error ? [item.error] : []),
  ]
  return (
    <ActivityRow
      data-testid={`activity-run-finished-${item.id}`}
      media={<RunMark icon={FileText} />}
      title={item.title}
      description={[tTasks(`kind.${item.taskKind}`), forPerson(item.forPerson)].join(SEPARATOR)}
      details={details}
      state={
        <StateChip variant={RUN_END_VARIANTS[item.status]}>
          {tTasks(`status.${item.status}`)}
        </StateChip>
      }
      at={item.at}
      actions={
        item.target ? (
          <TargetLink
            projectId={ctx.projectId}
            target={item.target}
            label={linkLabel(item.target)}
          />
        ) : null
      }
    />
  )
}

export function ChangesRow({ item, ctx }: { item: RecentChanges; ctx: RowContext }): JSX.Element {
  const { t, forPerson, linkLabel } = useRowText(ctx.viewerUserId)
  const names = item.documents.map((document) => document.name).join(', ')
  const more = item.documentCount - item.documents.length
  const where =
    more > 0
      ? t('project.pilotiActivity.changesInMore', { documents: names, count: more })
      : t('project.pilotiActivity.changesIn', { documents: names })
  const undone =
    item.undoneCount === 0
      ? null
      : item.undoneCount >= item.count
        ? t('project.pilotiActivity.changesUndone')
        : t('project.pilotiActivity.changesPartlyUndone', {
            undone: item.undoneCount,
            count: item.count,
          })
  return (
    <ActivityRow
      data-testid={`activity-changes-${item.id}`}
      media={<RunMark icon={History} />}
      title={t('project.pilotiActivity.changes', { count: item.count })}
      description={[where, forPerson(item.forPerson)].join(SEPARATOR)}
      state={undone ? <StateChip>{undone}</StateChip> : null}
      at={item.at}
      actions={
        <TargetLink projectId={ctx.projectId} target={item.target} label={linkLabel(item.target)} />
      }
    />
  )
}

const DECISION_VARIANTS: Record<RecentProposal['status'], ChipVariant> = {
  applied: 'success',
  partially_applied: 'warning',
  failed: 'destructive',
  dismissed: 'muted',
}

export function ProposalDecidedRow({
  item,
  ctx,
}: {
  item: RecentProposal
  ctx: RowContext
}): JSX.Element {
  const { t, forPerson, linkLabel } = useRowText(ctx.viewerUserId)
  // The reader's own decision reads „von Ihnen", as their own rows read „für Sie".
  const decider =
    item.decidedBy.userId === ctx.viewerUserId
      ? t('project.pilotiActivity.byYou')
      : (item.decidedBy.name ?? t('project.pilotiActivity.someone'))
  return (
    <ActivityRow
      data-testid={`activity-proposal-decided-${item.id}`}
      media={<RunMark icon={Sparkles} />}
      title={item.summary}
      description={[
        t(`project.pilotiActivity.proposal.${item.proposalKind}`),
        forPerson(item.forPerson),
      ].join(SEPARATOR)}
      state={
        <StateChip variant={DECISION_VARIANTS[item.status]}>
          {t(`project.pilotiActivity.proposalDecided.${item.status}`, { name: decider })}
        </StateChip>
      }
      at={item.at}
      actions={
        <TargetLink projectId={ctx.projectId} target={item.target} label={linkLabel(item.target)} />
      }
    />
  )
}
