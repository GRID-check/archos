'use client'

/**
 * „Verschieben nach …" as a place to choose, not a submenu to hover.
 *
 * A nested dropdown is a mouse gesture: its panel opens to the side of the item
 * that spawned it, and on a 393px phone there is no side. It opened off the
 * left edge with its first folders unreachable, and it could not scroll. A
 * choice among every folder of a shelf is a list with a search field, so it is
 * a Dialog (a bottom sheet on a phone): the folders scroll inside it, the field
 * narrows them, and each row is a full-width 44px target.
 *
 * One component for both callers, so a single document's „Verschieben" and a
 * selection's cannot drift: they differ in the title and in what happens on a
 * pick, which is the caller's.
 */

import type { JSX } from 'react'
import { useMemo, useState } from 'react'
import { Check, Folder, FolderOpen } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { SearchField } from '@/components/ui/search-field'
import { useTranslations } from '@/i18n'
import { filesCopy } from '@/i18n/namespaces/files'
import { cn } from '@/lib/utils'
import type { FolderDestination } from '../lib/folder-path-label'

export interface FolderPickerSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  /** The folders to choose from, labelled by full path and sorted (`sortedFolderDestinations`). */
  destinations: readonly FolderDestination[]
  /**
   * Where everything chosen already is (null: the shelf's top level), or
   * undefined when the choice spans several places. That row is marked and
   * cannot be picked: a move to where it already is says nothing.
   */
  currentFolderId?: string | null
  /**
   * Whether a destination may be chosen (null: the top level), for a caller
   * with rules of its own: a folder cannot go inside itself. Absent allows all.
   * A row it refuses is shown and cannot be pressed, as „Hier" is.
   */
  canPick?: (folderId: string | null) => boolean
  /** Pending: the rows stand still while the request is out. */
  pending?: boolean
  onPick: (folderId: string | null, label: string) => void
}

/** The ordered rows a query leaves: the top level first, then every folder whose path matches. */
function matching(
  destinations: readonly FolderDestination[],
  query: string
): readonly FolderDestination[] {
  const needle = query.trim().toLocaleLowerCase()
  if (needle === '') return destinations
  return destinations.filter(({ label }) => label.toLocaleLowerCase().includes(needle))
}

export function FolderPickerSheet({
  open,
  onOpenChange,
  title,
  destinations,
  currentFolderId,
  canPick,
  pending = false,
  onPick,
}: FolderPickerSheetProps): JSX.Element {
  const t = useTranslations(filesCopy)
  const [query, setQuery] = useState('')
  const rows = useMemo(() => matching(destinations, query), [destinations, query])
  const allFiles = t('folders.allFiles')
  const searching = query.trim() !== ''
  // The top level is a destination too, until a query says otherwise.
  const showRoot =
    !searching || allFiles.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setQuery('')
        onOpenChange(next)
      }}
    >
      <DialogContent
        className="gap-3"
        closeLabel={t('picker.close')}
        data-testid="folder-picker"
      >
        <DialogHeader>
          <DialogTitle className="pr-10 text-base leading-snug">{title}</DialogTitle>
          <DialogDescription className="sr-only">{t('picker.description')}</DialogDescription>
        </DialogHeader>
        <SearchField
          value={query}
          onChange={setQuery}
          placeholder={t('picker.search')}
          label={t('picker.search')}
          clearLabel={t('browser.resetSearch')}
        />
        <ul
          className="-mx-2 max-h-[min(55dvh,26rem)] overflow-y-auto overscroll-contain"
          aria-label={t('picker.list')}
          data-testid="folder-picker-list"
        >
          {showRoot && (
            <PickerRow
              label={allFiles}
              here={currentFolderId === null}
              disabled={pending || currentFolderId === null || canPick?.(null) === false}
              onPick={() => onPick(null, allFiles)}
              testId="folder-picker-root"
              root
            />
          )}
          {rows.map(({ folder, label }) => (
            <PickerRow
              key={folder.id}
              label={label}
              here={currentFolderId === folder.id}
              disabled={pending || currentFolderId === folder.id || canPick?.(folder.id) === false}
              onPick={() => onPick(folder.id, label)}
              testId={`folder-picker-${folder.id}`}
            />
          ))}
          {!showRoot && rows.length === 0 && (
            <li className="text-muted-foreground px-2 py-6 text-center text-sm">
              {t('picker.empty', { query: query.trim() })}
            </li>
          )}
        </ul>
      </DialogContent>
    </Dialog>
  )
}

function PickerRow({
  label,
  here,
  disabled,
  onPick,
  testId,
  root = false,
}: {
  label: string
  here: boolean
  disabled: boolean
  onPick: () => void
  testId: string
  root?: boolean
}): JSX.Element {
  const t = useTranslations(filesCopy)
  const Icon = here ? Check : root ? FolderOpen : Folder
  return (
    <li>
      <button
        type="button"
        disabled={disabled}
        onClick={onPick}
        aria-current={here ? 'true' : undefined}
        data-testid={testId}
        className={cn(
          'hover:bg-accent focus-visible:ring-ring duration-snap flex min-h-11 w-full items-center gap-3 rounded-lg px-2 py-2 text-left text-sm transition-colors ease-out focus-visible:outline-none focus-visible:ring-2 disabled:pointer-events-none motion-reduce:transition-none',
          here ? 'text-muted-foreground' : 'text-foreground disabled:opacity-50'
        )}
      >
        <Icon className="text-muted-foreground size-4 shrink-0" aria-hidden />
        <span className="min-w-0 flex-1 break-words">{label}</span>
        {here && <span className="text-muted-foreground shrink-0 text-xs">{t('picker.here')}</span>}
      </button>
    </li>
  )
}
