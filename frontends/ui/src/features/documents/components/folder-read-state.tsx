'use client'

import type { JSX } from 'react'
import { ToneSwatch, type MeterTone } from '@/components/ui/segment-meter'
import { useTranslations } from '@/i18n'
import { cn } from '@/lib/utils'
import { readMarkOf, type KnowledgeTally, type ReadMark } from '../lib/folder-knowledge'

export const READ_MARK_TONE: Record<ReadMark['state'], MeterTone> = {
  failed: 'destructive',
  held: 'warning',
  reading: 'info',
  unplaced: 'muted',
  allRead: 'success',
}

/** The dictionary key a mark reads as; every one takes `{count}`. */
export const READ_MARK_KEY: Record<ReadMark['state'], string> = {
  failed: 'brief.states.failed',
  held: 'brief.states.held',
  reading: 'brief.states.reading',
  unplaced: 'brief.unplacedShort',
  allRead: 'brief.allRead',
}

/**
 * Where a folder's WHOLE subtree stands with Piloti, as one swatch and a word:
 * „2 fehlgeschlagen", „3 werden gelesen", „Alles gelesen".
 *
 * On every folder tile and row, so the read state of nested folders is visible
 * from the level above them without opening each one — the first thing feld72
 * asked for. Nothing is drawn for an empty folder.
 *
 * `dotOnly` is the tile's form: the swatch alone, its words on hover and for a
 * screen reader. The colour is enough to browse by; spelled out on every tile
 * the state was louder than browsing needs. The list view's row keeps the words.
 */
export function FolderReadState({
  tally,
  withUnplaced = false,
  dotOnly = false,
  className,
}: {
  tally: KnowledgeTally | undefined
  withUnplaced?: boolean
  dotOnly?: boolean
  className?: string
}): JSX.Element | null {
  const t = useTranslations('files')
  const mark = tally ? readMarkOf(tally, { withUnplaced }) : null
  if (!mark) return null
  const words = t(READ_MARK_KEY[mark.state], { count: mark.count })
  return (
    <span
      className={cn('text-muted-foreground inline-flex shrink-0 items-center gap-1.5 text-xs', className)}
      data-testid="folder-read-state"
      data-state={mark.state}
      title={dotOnly ? words : undefined}
    >
      <ToneSwatch tone={READ_MARK_TONE[mark.state]} />
      {/* Truncates rather than pushing its row: the swatch stays, the words give way. */}
      <span className={dotOnly ? 'sr-only' : 'min-w-0 truncate'}>{words}</span>
    </span>
  )
}
