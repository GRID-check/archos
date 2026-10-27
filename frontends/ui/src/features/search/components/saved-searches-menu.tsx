'use client'

import type { FormEvent, JSX } from 'react'
import { useId, useMemo, useState } from 'react'
import { Bookmark, BookmarkPlus, MoreHorizontal, Pencil, Share2, Trash2, UserX } from 'lucide-react'
import { toast } from 'sonner'

import { ActionMenu, type ActionMenuEntry } from '@/components/ui/action-menu'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { SectionLabel } from '@/components/ui/section-label'
import { Switch } from '@/components/ui/switch'
import { PHONE_QUERY } from '@/hooks/use-is-mobile'
import { useMediaQuery } from '@/hooks/use-media-query'
import { useTranslations } from '@/i18n'
import type { SavedSearchView } from '@/lib/search/saved-search-client'
import { SAVED_SEARCH_NAME_MAX } from '@/lib/search/saved-search-wire'
import { SAVED_SEARCH_UNDO_MS, type SavedSearchRenameOutcome } from '../hooks/use-saved-searches'
import { useSearchLabels } from '../hooks/use-search-labels'
import type { ActiveFilter } from '../lib/active-filters'
import { savedSearchSummary } from '../lib/saved-search-summary'
import { ColleagueMark, DialogForm, PanelBody, QuietLine, RailAction, SavedSearchList, SavedSearchRow } from './search-atoms'

export interface SavedSearchesMenuProps {
  /** null while the list is read. */
  items: readonly SavedSearchView[] | null
  failed: boolean
  onApply: (item: SavedSearchView) => void
  onToggleShare: (item: SavedSearchView) => void
  /** Renames one's own; the dialog says so under the field when the name is taken. */
  onRename: (item: SavedSearchView, name: string) => Promise<SavedSearchRenameOutcome>
  /** Takes it out of the list; the delete is sent when the undo toast's window closes. */
  onDelete: (item: SavedSearchView) => void
  /** „Rückgängig“ in the toast, inside the window. */
  onUndoDelete: (item: SavedSearchView) => void
  /** Save the current search; resolves whether it was saved. */
  onSave: (draft: { name: string; shared: boolean }) => Promise<boolean>
  /** The name the save dialog opens with: the words and the chips of this search. */
  suggestedName?: string
  /** How long „Rückgängig“ is offered; the caller's undo window. */
  undoMs?: number
}

/**
 * The reader's saved searches and the ones colleagues shared, behind one
 * toolbar button: a name applies one, and under it one line says what it asks
 * (`savedSearchSummary`). The person who saved it shares, renames or deletes
 * it (with „Rückgängig“ in a toast) in the row's ⋯, the house's `ActionMenu`
 * as on a Dateien row; a colleague's names the colleague. Saving the current search is the list's
 * own last action, „Diese Suche speichern“, under a name it already proposes:
 * there is no second button beside the first for it.
 *
 * Wide, the list is a popover at the button; on a phone, the kit's bottom
 * sheet, where the thumb is.
 */
export function SavedSearchesMenu(props: SavedSearchesMenuProps): JSX.Element {
  const t = useTranslations('search.saved')
  const phone = useMediaQuery(PHONE_QUERY)
  const [open, setOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [renaming, setRenaming] = useState<SavedSearchView | null>(null)
  const body = (
    <SavedSearchesBody
      {...props}
      onApplied={() => setOpen(false)}
      onSaveRequested={() => {
        setOpen(false)
        setSaving(true)
      }}
      onRenameRequested={(item) => {
        setOpen(false)
        setRenaming(item)
      }}
    />
  )
  const trigger = (
    <Button type="button" variant="ghost" size="icon" aria-label={t('label')} title={t('label')} data-testid="saved-searches">
      <Bookmark aria-hidden />
    </Button>
  )
  const dialog = (
    <>
      <SaveSearchDialog open={saving} onOpenChange={setSaving} suggestedName={props.suggestedName ?? ''} onSave={props.onSave} />
      <RenameSearchDialog item={renaming} onClose={() => setRenaming(null)} onRename={props.onRename} />
    </>
  )
  if (phone) {
    return (
      <>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>{trigger}</DialogTrigger>
          <DialogContent data-testid="saved-searches-sheet">
            <DialogHeader>
              <DialogTitle>{t('label')}</DialogTitle>
              <DialogDescription className="sr-only">{t('dialogDescription')}</DialogDescription>
            </DialogHeader>
            {body}
          </DialogContent>
        </Dialog>
        {dialog}
      </>
    )
  }
  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>{trigger}</PopoverTrigger>
        <PopoverContent align="end">
          <PanelBody>
            <SectionLabel as="h3">{t('label')}</SectionLabel>
            {body}
          </PanelBody>
        </PopoverContent>
      </Popover>
      {dialog}
    </>
  )
}

/** The list and the save action, in whichever container the width gives them. */
function SavedSearchesBody({
  items,
  failed,
  onApply,
  onToggleShare,
  onDelete,
  onUndoDelete,
  undoMs = SAVED_SEARCH_UNDO_MS,
  onApplied,
  onSaveRequested,
  onRenameRequested,
}: SavedSearchesMenuProps & { onApplied: () => void; onSaveRequested: () => void; onRenameRequested: (item: SavedSearchView) => void }): JSX.Element {
  const t = useTranslations('search.saved')
  const summary = useSavedSearchSummary()
  const remove = (item: SavedSearchView): void => {
    onDelete(item)
    toast(t('deleted', { name: item.name }), {
      duration: undoMs,
      action: { label: t('undo'), onClick: () => onUndoDelete(item) },
    })
  }
  const detail = (item: SavedSearchView): string | undefined => {
    if (item.ownedByMe) return item.shared ? t('shared') : undefined
    return item.ownerName ? t('byColleague', { name: item.ownerName }) : t('fromColleague')
  }
  return (
    <>
      {failed ? (
        <QuietLine>{t('loadFailed')}</QuietLine>
      ) : items !== null && items.length === 0 ? (
        <QuietLine>{t('empty')}</QuietLine>
      ) : (
        <SavedSearchList>
          {(items ?? []).map((item) => (
            <SavedSearchRow
              key={item.id}
              name={item.name}
              summary={summary(item)}
              detail={detail(item)}
              onApply={() => {
                onApplied()
                onApply(item)
              }}
              controls={
                item.ownedByMe ? (
                  <SavedSearchItemMenu
                    item={item}
                    onToggleShare={() => onToggleShare(item)}
                    onRename={() => onRenameRequested(item)}
                    onDelete={() => remove(item)}
                  />
                ) : (
                  <ColleagueMark />
                )
              }
            />
          ))}
        </SavedSearchList>
      )}
      <RailAction>
        <Button type="button" size="sm" onClick={onSaveRequested} data-testid="saved-search-save">
          <BookmarkPlus aria-hidden />
          {t('save')}
        </Button>
      </RailAction>
    </>
  )
}

/** The line under a saved search's name: what it asks, in the chips' words. */
function useSavedSearchSummary(): (item: SavedSearchView) => string {
  const t = useTranslations('search')
  const labels = useSearchLabels()
  return useMemo(() => {
    const words = {
      quote: (text: string) => t('saved.summaryText', { text }),
      register: t('views.register'),
      // A saved search's project is its scope, which `fromSearchBody` leaves out: no project chip to name.
      filter: (filter: ActiveFilter) => labels.activeFilter(filter, () => null),
      everything: t('saved.summaryEverything'),
    }
    return (item: SavedSearchView) => savedSearchSummary(item.query, words)
  }, [t, labels])
}

/**
 * One's own saved search's ⋯: share or stop sharing, rename, and delete set
 * apart, as a Dateien row orders its operations.
 */
function SavedSearchItemMenu({
  item,
  onToggleShare,
  onRename,
  onDelete,
}: {
  item: SavedSearchView
  onToggleShare: () => void
  onRename: () => void
  onDelete: () => void
}): JSX.Element {
  const t = useTranslations('search.saved')
  const entries: ActionMenuEntry[] = [
    {
      type: 'item',
      id: 'share',
      label: item.shared ? t('unshare') : t('shareAction'),
      icon: item.shared ? UserX : Share2,
      onSelect: onToggleShare,
      testId: 'saved-search-share',
    },
    { type: 'item', id: 'rename', label: t('rename'), icon: Pencil, onSelect: onRename, testId: 'saved-search-rename' },
    { type: 'separator' },
    { type: 'item', id: 'delete', label: t('deleteAction'), icon: Trash2, variant: 'destructive', onSelect: onDelete, testId: 'saved-search-delete' },
  ]
  return (
    <ActionMenu
      mode="dropdown"
      entries={entries}
      trigger={
        <Button type="button" variant="ghost" size="icon" className="size-8" aria-label={t('actions', { name: item.name })} data-testid="saved-search-actions">
          <MoreHorizontal aria-hidden />
        </Button>
      }
    />
  )
}

/** „Umbenennen“: the name in a field, ready to type over; a name already taken is said under the field. */
function RenameSearchDialog({
  item,
  onClose,
  onRename,
}: {
  item: SavedSearchView | null
  onClose: () => void
  onRename: (item: SavedSearchView, name: string) => Promise<SavedSearchRenameOutcome>
}): JSX.Element {
  return (
    <Dialog open={item !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent>{item ? <RenameSearchForm key={item.id} item={item} onRename={onRename} onDone={onClose} /> : null}</DialogContent>
    </Dialog>
  )
}

function RenameSearchForm({
  item,
  onRename,
  onDone,
}: {
  item: SavedSearchView
  onRename: (item: SavedSearchView, name: string) => Promise<SavedSearchRenameOutcome>
  onDone: () => void
}): JSX.Element {
  const t = useTranslations('search.saved')
  const id = useId()
  const [name, setName] = useState(item.name)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<'missing' | 'taken' | null>(null)
  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    const trimmed = name.trim().slice(0, SAVED_SEARCH_NAME_MAX)
    if (busy) return
    if (!trimmed) {
      setProblem('missing')
      return
    }
    if (trimmed === item.name) {
      onDone()
      return
    }
    setBusy(true)
    const outcome = await onRename(item, trimmed)
    setBusy(false)
    if (outcome === 'renamed') onDone()
    else if (outcome === 'taken') setProblem('taken')
    else toast.error(t('changeFailed'))
  }
  return (
    <DialogForm onSubmit={(event) => void submit(event)}>
      <DialogHeader>
        <DialogTitle>{t('renameTitle')}</DialogTitle>
        <DialogDescription>{t('renameDescription')}</DialogDescription>
      </DialogHeader>
      <Field>
        <FieldLabel htmlFor={`${id}-name`}>{t('name')}</FieldLabel>
        <Input
          id={`${id}-name`}
          value={name}
          maxLength={SAVED_SEARCH_NAME_MAX}
          onChange={(event) => {
            setName(event.target.value)
            setProblem(null)
          }}
          onFocus={(event) => event.currentTarget.select()}
          aria-invalid={problem !== null || undefined}
          aria-describedby={problem ? `${id}-name-error` : undefined}
          autoFocus
          data-testid="saved-search-rename-name"
        />
        {problem ? <FieldError id={`${id}-name-error`}>{problem === 'missing' ? t('nameRequired') : t('nameTaken')}</FieldError> : null}
      </Field>
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onDone}>
          {t('cancel')}
        </Button>
        <Button type="submit" loading={busy} data-testid="saved-search-rename-confirm">
          {t('renameConfirm')}
        </Button>
      </DialogFooter>
    </DialogForm>
  )
}

function SaveSearchDialog({
  open,
  onOpenChange,
  suggestedName,
  onSave,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  suggestedName: string
  onSave: (draft: { name: string; shared: boolean }) => Promise<boolean>
}): JSX.Element {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        {/* Mounted with each opening, so it starts from the search as it is now. */}
        <SaveSearchForm suggestedName={suggestedName} onSave={onSave} onDone={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  )
}

/**
 * The dialog's form. It opens with the name filled from the search, so
 * „Speichern“ is ready at once; the button is never disabled for an empty
 * name (a disabled button cannot say why), it says so under the field instead.
 */
function SaveSearchForm({
  suggestedName,
  onSave,
  onDone,
}: {
  suggestedName: string
  onSave: (draft: { name: string; shared: boolean }) => Promise<boolean>
  onDone: () => void
}): JSX.Element {
  const t = useTranslations('search.saved')
  const id = useId()
  const [name, setName] = useState(suggestedName.slice(0, SAVED_SEARCH_NAME_MAX))
  const [shared, setShared] = useState(false)
  const [busy, setBusy] = useState(false)
  const [missing, setMissing] = useState(false)
  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    const trimmed = name.trim()
    if (busy) return
    if (!trimmed) {
      setMissing(true)
      return
    }
    setBusy(true)
    const saved = await onSave({ name: trimmed.slice(0, SAVED_SEARCH_NAME_MAX), shared })
    setBusy(false)
    if (saved) onDone()
  }
  return (
    <DialogForm onSubmit={(event) => void submit(event)}>
      <DialogHeader>
        <DialogTitle>{t('dialogTitle')}</DialogTitle>
        <DialogDescription>{t('dialogDescription')}</DialogDescription>
      </DialogHeader>
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor={`${id}-name`}>{t('name')}</FieldLabel>
          <Input
            id={`${id}-name`}
            value={name}
            maxLength={SAVED_SEARCH_NAME_MAX}
            placeholder={t('namePlaceholder')}
            onChange={(event) => {
              setName(event.target.value)
              if (event.target.value.trim()) setMissing(false)
            }}
            onFocus={(event) => event.currentTarget.select()}
            aria-invalid={missing || undefined}
            aria-describedby={missing ? `${id}-name-error` : undefined}
            autoFocus
            data-testid="saved-search-name"
          />
          {missing ? <FieldError id={`${id}-name-error`}>{t('nameRequired')}</FieldError> : null}
        </Field>
        <Field orientation="horizontal">
          <div>
            <FieldLabel htmlFor={`${id}-share`}>{t('share')}</FieldLabel>
            <FieldDescription>{t('shareHint')}</FieldDescription>
          </div>
          <Switch id={`${id}-share`} checked={shared} onCheckedChange={setShared} data-testid="saved-search-shared" />
        </Field>
      </FieldGroup>
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onDone}>
          {t('cancel')}
        </Button>
        <Button type="submit" loading={busy} data-testid="saved-search-confirm">
          {t('confirm')}
        </Button>
      </DialogFooter>
    </DialogForm>
  )
}
