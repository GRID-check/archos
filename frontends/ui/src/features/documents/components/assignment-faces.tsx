'use client'

import { AvatarStack } from '@/components/ui/avatar-stack'
import { useTranslations } from '@/i18n'
import type { FileAssignee } from './project-file-workspace'
import { cn } from '@/lib/utils'
import { UserRound } from 'lucide-react'

export function AssignmentFaces({
  assignees,
  faceOnly = false,
  className,
}: {
  assignees: readonly FileAssignee[] | undefined
  /**
   * The faces and nothing else, for a host that names the people itself (the
   * preview's contact row). Nobody assigned is then an empty disc rather than
   * the word „Unvergeben", which that host already says as its title.
   */
  faceOnly?: boolean
  className?: string
}) {
  const t = useTranslations('files')
  if ((!assignees || assignees.length === 0) && faceOnly) {
    return (
      <span
        className={cn('border-border text-muted-foreground/60 flex size-7 shrink-0 items-center justify-center rounded-full border border-dashed', className)}
        aria-hidden
      >
        <UserRound className="size-3.5" />
      </span>
    )
  }
  if (!assignees || assignees.length === 0) {
    // On a phone the word does not fit a 2-up card's footer („Unv…"), and a cut
    // word says nothing. There it is the dashed empty disc the preview uses,
    // with the word kept for assistive technology and the long-press title.
    return (
      <span
        className={cn('flex min-w-0 items-center text-xs text-muted-foreground', className)}
        title={t('assignment.unassigned')}
        data-testid="assignment-unassigned"
      >
        <span
          aria-hidden
          className="border-border text-muted-foreground/60 hidden size-5 shrink-0 items-center justify-center rounded-full border border-dashed phone:flex"
        >
          <UserRound className="size-3" />
        </span>
        <span className="truncate phone:sr-only">{t('assignment.unassigned')}</span>
      </span>
    )
  }
  const people = assignees.map((person) => ({
    userId: person.userId,
    name: person.name || person.email || person.userId,
    profilePictureUrl: person.profilePictureUrl,
  }))
  return (
    <span className={cn('flex min-w-0 items-center gap-1.5', className)} title={people.map((p) => p.name).join(', ')}>
      <AvatarStack people={people} size="sm" max={3} />
    </span>
  )
}
