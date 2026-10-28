'use client'

/**
 * The tiles that load in the browser, from the endpoints their sections read,
 * so a tile and its section can never disagree about a count.
 */

import type { JSX } from 'react'
import { useEffect, useState } from 'react'
import { Brain, Pin, Users } from 'lucide-react'
import { listProjectMemory, type ProjectMemoryEntry } from '@/adapters/api/project-memory-client'
import { listProjectMembers, type ProjectMember } from '@/adapters/api/project-members-client'
import { collectPages } from '@/lib/api/offset-page'
import { AvatarStack } from '@/components/ui/avatar-stack'
import { BentoFigure, BentoTile, type BentoSpan } from '@/components/ui/bento'
import { Chip } from '@/components/ui/chip'
import { Skeleton } from '@/components/ui/skeleton'
import { useTranslations } from '@/i18n'

type Load<T> = { state: 'loading' } | { state: 'error' } | { state: 'ready'; value: T }

/**
 * The loading tile, drawn in the loaded tile's shape so the overview does not
 * jump when the numbers land: the figure's line boxes (`text-3xl` over a
 * `text-sm` caption, as `BentoFigure` sets them) and then what sits under it,
 * two clamped note lines or the avatar stack. The old two-bar skeleton was
 * about half the height of either body, so every tile grew on arrival.
 */
function TileSkeleton({ under }: { under: 'lines' | 'avatars' }): JSX.Element {
  return (
    <>
      <div aria-hidden>
        <Skeleton className="h-9 w-16" />
        <Skeleton className="mt-1 h-5 w-32" />
      </div>
      {under === 'lines' ? (
        <div className="flex flex-col gap-1.5" aria-hidden>
          <Skeleton className="h-5 w-full" />
          <Skeleton className="h-5 w-4/5" />
        </div>
      ) : (
        <Skeleton className="h-8 w-28 rounded-full" aria-hidden />
      )}
    </>
  )
}

/** The project's memory, every page, read once on mount; ignored if the tile unmounts first. */
function useMemoryNotes(projectId: string): Load<ProjectMemoryEntry[]> {
  const [load, setLoad] = useState<Load<ProjectMemoryEntry[]>>({ state: 'loading' })
  useEffect(() => {
    let live = true
    collectPages((cursor) => listProjectMemory(projectId, { limit: 200, cursor }))
      .then((notes) => {
        if (live) setLoad({ state: 'ready', value: notes })
      })
      .catch(() => {
        if (live) setLoad({ state: 'error' })
      })
    return () => {
      live = false
    }
  }, [projectId])
  return load
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
  const load = useMemoryNotes(projectId)

  return (
    <BentoTile
      label={t('project.overview.memory.label')}
      icon={Brain}
      span={span}
      href={href}
      linkLabel={t('project.overview.memory.open')}
      data-testid="overview-memory"
    >
      {load.state === 'loading' && <TileSkeleton under="lines" />}
      {load.state === 'error' && (
        <p className="text-muted-foreground text-sm">{t('project.overview.memory.error')}</p>
      )}
      {load.state === 'ready' && <MemoryBody notes={load.value} />}
    </BentoTile>
  )
}

function MemoryBody({ notes }: { notes: readonly ProjectMemoryEntry[] }): JSX.Element {
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

/** The project's role holders, read once on mount; ignored if the tile unmounts first. */
function useRoster(projectId: string): Load<ProjectMember[]> {
  const [load, setLoad] = useState<Load<ProjectMember[]>>({ state: 'loading' })
  useEffect(() => {
    let live = true
    listProjectMembers(projectId)
      .then((members) => {
        if (live) setLoad({ state: 'ready', value: members.filter((member) => member.role) })
      })
      .catch(() => {
        if (live) setLoad({ state: 'error' })
      })
    return () => {
      live = false
    }
  }, [projectId])
  return load
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
  const load = useRoster(projectId)

  return (
    <BentoTile
      label={t('project.overview.members.label')}
      icon={Users}
      span={span}
      href={href}
      linkLabel={t('project.overview.members.open')}
      data-testid="overview-members"
    >
      {load.state === 'loading' && <TileSkeleton under="avatars" />}
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
