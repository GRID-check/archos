'use client'

/**
 * The tiles that load in the browser, from the endpoints their sections read,
 * so a tile and its section can never disagree about a count.
 */

import type { JSX } from 'react'
import { useEffect, useState } from 'react'
import { Brain, Pin, Sparkles, Users } from 'lucide-react'
import { AvatarStack } from '@/components/ui/avatar-stack'
import { BentoFigure, BentoTile, type BentoSpan } from '@/components/ui/bento'
import { Chip } from '@/components/ui/chip'
import { PilotiGlyph } from '@/components/ui/piloti-glyph'
import { Skeleton } from '@/components/ui/skeleton'
import { useTranslations } from '@/i18n'
import { usePilotiActivity, type PilotiActivityFetcher } from '@/features/piloti-activity/hooks/use-piloti-activity'
import { activityCounts, type ActivityCounts } from '@/features/piloti-activity/lib/activity-counts'
import type { RunningItem } from '@/lib/piloti-activity/types'

type Load<T> = { state: 'loading' } | { state: 'error' } | { state: 'ready'; value: T }

/** One GET, read once on mount; aborted if the tile unmounts first. */
function useJson<T>(url: string, pick: (body: unknown) => T): Load<T> {
  const [load, setLoad] = useState<Load<T>>({ state: 'loading' })
  useEffect(() => {
    const controller = new AbortController()
    fetch(url, { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(String(res.status))
        setLoad({ state: 'ready', value: pick(await res.json()) })
      })
      .catch(() => {
        if (!controller.signal.aborted) setLoad({ state: 'error' })
      })
    return () => controller.abort()
    // `pick` is a pure projection; re-reading on its identity would refetch every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url])
  return load
}

function TileSkeleton(): JSX.Element {
  return (
    <div className="space-y-2" aria-hidden>
      <Skeleton className="h-8 w-16" />
      <Skeleton className="h-4 w-32" />
    </div>
  )
}

interface MemoryNote {
  id: string
  content: string
  pinned: boolean
  verification: string
}

/** How much Piloti has noted, how much a person still has to look at, and the pinned notes. */
export function MemoryTile({
  projectId,
  href,
  span = 'small',
}: {
  projectId: string
  href: string
  span?: BentoSpan
}): JSX.Element {
  const t = useTranslations('settings')
  const load = useJson(
    `/api/projects/${encodeURIComponent(projectId)}/memory`,
    (body) => ((body as { items?: MemoryNote[] }).items ?? []) as MemoryNote[]
  )

  return (
    <BentoTile
      label={t('project.overview.memory.label')}
      icon={Brain}
      span={span}
      href={href}
      linkLabel={t('project.overview.memory.open')}
      data-testid="overview-memory"
    >
      {load.state === 'loading' && <TileSkeleton />}
      {load.state === 'error' && (
        <p className="text-muted-foreground text-sm">{t('project.overview.memory.error')}</p>
      )}
      {load.state === 'ready' && <MemoryBody notes={load.value} />}
    </BentoTile>
  )
}

function MemoryBody({ notes }: { notes: readonly MemoryNote[] }): JSX.Element {
  const t = useTranslations('settings')
  if (notes.length === 0) {
    return <p className="text-muted-foreground text-sm">{t('project.overview.memory.empty')}</p>
  }
  const toReview = notes.filter((note) => note.verification === 'unverified').length
  const shown = [...notes].sort((a, b) => Number(b.pinned) - Number(a.pinned)).slice(0, 2)

  return (
    <>
      <div className="flex items-end justify-between gap-3">
        <BentoFigure
          value={notes.length}
          caption={t('project.overview.memory.notes', { count: notes.length })}
        />
        <Chip variant={toReview > 0 ? 'warning' : 'success'} size="sm">
          {toReview > 0
            ? t('project.overview.memory.toReview', { count: toReview })
            : t('project.overview.memory.allReviewed')}
        </Chip>
      </div>
      <ul className="flex flex-col gap-1.5 text-sm">
        {shown.map((note) => (
          <li key={note.id} className="flex items-start gap-1.5">
            {note.pinned && (
              <Pin className="text-muted-foreground mt-1 size-3 shrink-0" aria-hidden />
            )}
            <span className="line-clamp-2 min-w-0">{note.content}</span>
          </li>
        ))}
      </ul>
    </>
  )
}

interface RosterEntry {
  userId: string
  name: string
  profilePictureUrl: string | null
  role: string | null
}

/** Who is assigned to the project: the faces and the count. */
export function MembersTile({
  projectId,
  href,
  span = 'small',
}: {
  projectId: string
  href: string
  span?: BentoSpan
}): JSX.Element {
  const t = useTranslations('settings')
  const load = useJson(`/api/projects/${encodeURIComponent(projectId)}/members`, (body) =>
    (((body as { members?: RosterEntry[] }).members ?? []) as RosterEntry[]).filter(
      (member) => member.role
    )
  )

  return (
    <BentoTile
      label={t('project.overview.members.label')}
      icon={Users}
      span={span}
      href={href}
      linkLabel={t('project.overview.members.open')}
      data-testid="overview-members"
    >
      {load.state === 'loading' && <TileSkeleton />}
      {load.state === 'error' && (
        <p className="text-muted-foreground text-sm">{t('project.overview.members.error')}</p>
      )}
      {load.state === 'ready' &&
        (load.value.length === 0 ? (
          <p className="text-muted-foreground text-sm">{t('project.overview.members.empty')}</p>
        ) : (
          <>
            <BentoFigure
              value={load.value.length}
              caption={t('project.overview.members.count', { count: load.value.length })}
            />
            <AvatarStack
              people={load.value.map((member) => ({
                userId: member.userId,
                name: member.name,
                profilePictureUrl: member.profilePictureUrl,
              }))}
              max={6}
            />
          </>
        ))}
    </BentoTile>
  )
}

/**
 * What Piloti is doing: how many things run now, how many wait for a decision,
 * and the one running first. Read through the typed client, the same one the
 * section reads through, so the tile and the section parse one contract and
 * count with one function. A count the server cut off (`truncated`) says
 * „und weitere" beside the number rather than claiming a total.
 */
export function PilotiTile({
  projectId,
  href,
  span = 'wide',
  fetcher,
}: {
  projectId: string
  href: string
  span?: BentoSpan
  /** Where the tile reads from; stable across renders. Default: the typed client. */
  fetcher?: PilotiActivityFetcher
}): JSX.Element {
  const t = useTranslations('settings')
  const { activity, failed } = usePilotiActivity(projectId, fetcher)

  return (
    <BentoTile
      label={t('project.overview.piloti.label')}
      icon={Sparkles}
      span={span}
      href={href}
      linkLabel={t('project.overview.piloti.open')}
      data-testid="overview-piloti"
    >
      {!activity && !failed && <TileSkeleton />}
      {!activity && failed && (
        <p className="text-muted-foreground text-sm">{t('project.overview.piloti.error')}</p>
      )}
      {activity && (
        <PilotiBody counts={activityCounts(activity)} first={activity.running.items[0] ?? null} />
      )}
    </BentoTile>
  )
}

function PilotiBody({
  counts,
  first,
}: {
  counts: ActivityCounts
  first: RunningItem | null
}): JSX.Element {
  const t = useTranslations('settings')
  const more = (truncated: boolean): string | null => (truncated ? t('project.overview.piloti.more') : null)
  const lines = [
    {
      key: 'running',
      count: counts.running,
      text:
        counts.running > 0
          ? t('project.overview.piloti.running', { count: counts.running })
          : t('project.overview.piloti.runningNone'),
      more: more(counts.runningTruncated),
    },
    {
      key: 'waiting',
      count: counts.waiting,
      text:
        counts.waiting > 0
          ? t('project.overview.piloti.waiting', { count: counts.waiting })
          : t('project.overview.piloti.waitingNone'),
      more: more(counts.waitingTruncated),
    },
  ]
  const firstTitle =
    first === null
      ? null
      : first.kind === 'run'
        ? first.title
        : `${t('project.pilotiActivity.mark', { number: first.mark.number })} · ${first.document.name}`

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-x-8 gap-y-2">
        <PilotiGlyph size="md" working={counts.running > 0} />
        {lines.map((line) => (
          <p
            key={line.key}
            className={
              line.count > 0
                ? 'text-xl font-semibold tabular-nums tracking-tight'
                : 'text-muted-foreground text-xl tracking-tight'
            }
          >
            {line.text}
            {line.more && <span className="text-muted-foreground ml-2 text-sm font-normal">{line.more}</span>}
          </p>
        ))}
      </div>
      {firstTitle && (
        <p className="text-muted-foreground truncate text-sm">
          {t('project.overview.piloti.now', { title: firstTitle })}
        </p>
      )}
    </div>
  )
}
