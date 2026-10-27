'use client'

import type { FormEvent, JSX } from 'react'
import { useId, useState } from 'react'
import { Bookmark, BookmarkPlus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { SectionLabel } from '@/components/ui/section-label'
import { Switch } from '@/components/ui/switch'
import { useTranslations } from '@/i18n'
import type { SavedSearchView } from '@/lib/search/saved-search-client'
import { SAVED_SEARCH_NAME_MAX } from '@/lib/search/saved-search-wire'
import { SAVED_SEARCH_UNDO_MS } from '../hooks/use-saved-searches'
import { ColleagueMark, DialogForm, SwitchCaption, PanelBody, QuietLine, RailAction, SavedSearchList, SavedSearchRow, ToolbarLabel } from './search-atoms'

export interface SavedSearchesMenuProps {
  /** null while the list is read. */
  items: readonly SavedSearchView[] | null
  failed: boolean
  onApply: (item: SavedSearchView) => void
  onToggleShare: (item: SavedSearchView) => void
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
 * A narrow toolbar has no room for the two buttons, so its „Mehr“ menu opens
 * the list and the save dialog instead, and holds their open state.
 */
export interface NarrowSavedSearches {
  listOpen: boolean
  onListOpenChange: (open: boolean) => void
  saveOpen: boolean
  onSaveOpenChange: (open: boolean) => void
}

/**
 * The reader's saved searches and the ones colleagues shared: a name applies
 * one, the person who saved it shares it with the switch beside its word or
 * deletes it (with „Rückgängig“ in a toast), a colleague's names the colleague,
 * and the current search is saved from here under a name it already proposes.
 *
 * Two presentations of the one list. Wide: two toolbar buttons, the list in a
 * popover at the first. Narrow (`narrow`): no buttons, the parent's „Mehr“
 * menu opens the list, which is then the kit's bottom sheet, since there is no
 * button left to hang a popover from.
 */
export function SavedSearchesMenu({ narrow, ...props }: SavedSearchesMenuProps & { narrow?: NarrowSavedSearches | null }): JSX.Element {
  const t = useTranslations('search.saved')
  const [wideOpen, setWideOpen] = useState(false)
  const [wideSaving, setWideSaving] = useState(false)
  const open = narrow ? narrow.listOpen : wideOpen
  const setOpen = narrow ? narrow.onListOpenChange : setWideOpen
  const saving = narrow ? narrow.saveOpen : wideSaving
  const setSaving = narrow ? narrow.onSaveOpenChange : setWideSaving
  const body = (
    <SavedSearchesBody
      {...props}
      onApplied={() => setOpen(false)}
      onSaveRequested={() => {
        setOpen(false)
        setSaving(true)
      }}
    />
  )
  const dialog = <SaveSearchDialog open={saving} onOpenChange={setSaving} suggestedName={props.suggestedName ?? ''} onSave={props.onSave} />
  if (narrow) {
    return (
      <>
        <Dialog open={open} onOpenChange={setOpen}>
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
        <PopoverTrigger asChild>
          <Button type="button" variant="outline" size="sm" aria-label={t('label')} data-testid="saved-searches">
            <Bookmark aria-hidden />
            <ToolbarLabel>{t('menu')}</ToolbarLabel>
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end">
          <PanelBody>
            <SectionLabel as="h3">{t('label')}</SectionLabel>
            {body}
          </PanelBody>
        </PopoverContent>
      </Popover>
      <Button type="button" variant="outline" size="sm" aria-label={t('save')} onClick={() => setSaving(true)} data-testid="saved-search-save-toolbar">
        <BookmarkPlus aria-hidden />
        <ToolbarLabel>{t('saveShort')}</ToolbarLabel>
      </Button>
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
}: SavedSearchesMenuProps & { onApplied: () => void; onSaveRequested: () => void }): JSX.Element {
  const t = useTranslations('search.saved')
  const remove = (item: SavedSearchView): void => {
    onDelete(item)
    toast(t('deleted', { name: item.name }), {
      duration: undoMs,
      action: { label: t('undo'), onClick: () => onUndoDelete(item) },
    })
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
              detail={item.ownedByMe ? undefined : item.ownerName ? t('byColleague', { name: item.ownerName }) : t('fromColleague')}
              onApply={() => {
                onApplied()
                onApply(item)
              }}
              controls={
                item.ownedByMe ? (
                  <>
                    <SwitchCaption label={t('sharedSwitch')}>
                      <Switch
                        checked={item.shared}
                        onCheckedChange={() => onToggleShare(item)}
                        aria-label={t('shareToggle', { name: item.name })}
                        data-testid="saved-search-share"
                      />
                    </SwitchCaption>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label={t('delete', { name: item.name })}
                      onClick={() => remove(item)}
                      data-testid="saved-search-delete"
                    >
                      <Trash2 aria-hidden />
                    </Button>
                  </>
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
          {t('save')}
        </Button>
      </RailAction>
    </>
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
