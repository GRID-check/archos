'use client'

import type { JSX } from 'react'
import { FolderInput, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslations } from '@/i18n'

export interface SelectionBarProps {
  /** How many documents are picked. */
  count: number
  /** How many the level holds, so „Alle" can say it is already everything. */
  total: number
  onSelectAll: () => void
  onMove: () => void
  /** Leave the selection mode. */
  onDone: () => void
  /** Moving is out of reach on a level the reader may only read. */
  canMove: boolean
}

/**
 * What can be done to the documents picked, at the foot of the listing.
 *
 * In flow at the bottom of the workspace and not `fixed`: the phone's tab bar
 * is in flow under the page, so this sits on top of it with no height to guess
 * and no home-indicator inset to double up on. The thumb is at the bottom of the
 * screen; the controls are there. The count is announced as a status because it
 * is the one thing that changes on every tap.
 */
export function SelectionBar({
  count,
  total,
  onSelectAll,
  onMove,
  onDone,
  canMove,
}: SelectionBarProps): JSX.Element {
  const t = useTranslations('files')
  return (
    <div
      className="bg-background animate-in fade-in-0 slide-in-from-bottom-2 duration-base flex shrink-0 items-center gap-2 border-t px-3 pb-[max(0.5rem,var(--shell-inset-bottom,env(safe-area-inset-bottom)))] pt-2 ease-out motion-reduce:animate-none sm:px-4"
      data-testid="selection-bar"
    >
      <Button
        type="button"
        variant="ghost"
        size="icon"
        onClick={onDone}
        aria-label={t('selection.done')}
        data-testid="selection-done"
      >
        <X aria-hidden />
      </Button>
      <p
        className="min-w-0 flex-1 truncate text-sm font-medium tabular-nums"
        role="status"
        data-testid="selection-count"
      >
        {t('selection.count', { count })}
      </p>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={onSelectAll}
        disabled={count >= total}
        data-testid="selection-all"
      >
        {t('selection.all')}
      </Button>
      {canMove && (
        <Button
          type="button"
          size="sm"
          className="gap-2"
          onClick={onMove}
          disabled={count === 0}
          data-testid="selection-move"
        >
          <FolderInput className="size-4" aria-hidden />
          {t('selection.move')}
        </Button>
      )}
    </div>
  )
}
