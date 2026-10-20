'use client'

/**
 * The Fassung count on a document, and the mark of an older one.
 *
 * A document with Fassungen under other file names is ONE entry in the listing
 * (`revision-chain.ts`), so the entry says how many states it has. Two shapes,
 * for two different facts:
 *
 * - {@link RevisionCount}: „3 Fassungen", quiet text: beside the name in the
 *   list, after the approval state on a card (where the name has no room).
 *   It is the document's history, not a statement about its content
 *   („Freigegeben", `document-version-badge.tsx`, ADR-0054), so it is never a
 *   second badge and never in the list's „Freigabe" column, where it made
 *   rows wrap to two lines and said the history was an approval state.
 * - {@link OlderRevisionBadge}: the ONE badge an older Fassung carries, shown
 *   only when a reader asked for older Fassungen. Its tooltip names what
 *   replaced it. The lifecycle's „Ersetzt" beside it said the same thing twice
 *   and did not say by what, so a row that shows this badge shows no approval
 *   state ({@link isOlderRevisionEntry}).
 *
 * Not interactive: the whole card or row opens the preview, whose Fassungen
 * section lists every state.
 */

import type { JSX } from 'react'
import { Badge } from '@/components/ui/badge'
import { useTranslations } from '@/i18n'
import { cn } from '@/lib/utils'
import type { FileItem } from '../file-types'
import { revisionCount } from '../lib/revision-chain'

/** Whether a person confirmed a newer Fassung of this file: it is an older one, and says only that. */
export function isOlderRevisionEntry(file: FileItem): boolean {
  return file.revision?.supersededBy != null
}

/** „3 Fassungen" beside the name, or nothing for a document with one state or for an older Fassung. */
export function RevisionCount({
  file,
  className,
}: {
  file: FileItem
  className?: string
}): JSX.Element | null {
  const t = useTranslations('files')
  // An older Fassung's own count would read as the document's, which is the
  // thing the older one is not.
  if (isOlderRevisionEntry(file)) return null
  const count = revisionCount(file)
  if (count <= 1) return null
  return (
    <span
      className={cn(
        'text-muted-foreground shrink-0 whitespace-nowrap text-xs font-normal tabular-nums',
        className
      )}
      title={t('revisionBadge.countTitle', { count })}
      data-testid="revision-count"
    >
      {t('revisionBadge.count', { count })}
    </span>
  )
}

/** „Ältere Fassung", with „Ersetzt durch …" on hover; nothing for a current one. */
export function OlderRevisionBadge({
  file,
  className,
}: {
  file: FileItem
  className?: string
}): JSX.Element | null {
  const t = useTranslations('files')
  const newer = file.revision?.supersededBy
  if (!newer) return null
  const replacedBy = t('revisionBadge.olderTitle', { name: newer.filename })
  return (
    <Badge
      variant="outline"
      className={cn('text-muted-foreground shrink-0 font-normal', className)}
      title={replacedBy}
      aria-label={`${t('revisionBadge.older')}. ${replacedBy}`}
      data-testid="revision-badge"
      data-state="older"
    >
      {t('revisionBadge.older')}
    </Badge>
  )
}
