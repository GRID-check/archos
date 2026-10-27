'use client'

import type { FormEvent, JSX } from 'react'
import { useId, useState } from 'react'
import { Bookmark, BookmarkPlus, Trash2, Users } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { SectionLabel } from '@/components/ui/section-label'
import { Switch } from '@/components/ui/switch'
import { useTranslations } from '@/i18n'
import type { SavedSearchView } from '@/lib/search/saved-search-client'
import { PanelBody, QuietLine, RailAction, SavedSearchList, SavedSearchRow, ToolbarLabel } from './search-atoms'

export interface SavedSearchesMenuProps {
  /** null while the list is read. */
  items: readonly SavedSearchView[] | null
  failed: boolean
  onApply: (item: SavedSearchView) => void
  onToggleShare: (item: SavedSearchView) => void
  onDelete: (item: SavedSearchView) => void
  /** Save the current search; resolves whether it was saved. */
  onSave: (draft: { name: string; shared: boolean }) => Promise<boolean>
}

/**
 * The reader's saved searches and the ones colleagues shared: a name applies
 * one, the person who saved it can share or delete it, and the current search
 * is saved from here under a name.
 */
export function SavedSearchesMenu({ items, failed, onApply, onToggleShare, onDelete, onSave }: SavedSearchesMenuProps): JSX.Element {
  const t = useTranslations('search.saved')
  const [open, setOpen] = useState(false)
  const [saving, setSaving] = useState(false)
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
                    detail={item.ownedByMe ? (item.shared ? t('shared') : undefined) : t('fromColleague')}
                    onApply={() => {
                      setOpen(false)
                      onApply(item)
                    }}
                    controls={
                      item.ownedByMe ? (
                        <>
                          <Switch
                            checked={item.shared}
                            onCheckedChange={() => onToggleShare(item)}
                            aria-label={t('shareToggle', { name: item.name })}
                            data-testid="saved-search-share"
                          />
                          <Button type="button" variant="ghost" size="icon" aria-label={t('delete', { name: item.name })} onClick={() => onDelete(item)} data-testid="saved-search-delete">
                            <Trash2 aria-hidden />
                          </Button>
                        </>
                      ) : (
                        <Users aria-hidden />
                      )
                    }
                  />
                ))}
              </SavedSearchList>
            )}
            <RailAction>
              <Button
                type="button"
                size="sm"
                onClick={() => {
                  setOpen(false)
                  setSaving(true)
                }}
                data-testid="saved-search-save"
              >
                {t('save')}
              </Button>
            </RailAction>
          </PanelBody>
        </PopoverContent>
      </Popover>
      <Button type="button" variant="outline" size="sm" aria-label={t('save')} onClick={() => setSaving(true)} data-testid="saved-search-save-toolbar">
        <BookmarkPlus aria-hidden />
        <ToolbarLabel>{t('saveShort')}</ToolbarLabel>
      </Button>
      <SaveSearchDialog open={saving} onOpenChange={setSaving} onSave={onSave} />
    </>
  )
}

function SaveSearchDialog({
  open,
  onOpenChange,
  onSave,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSave: (draft: { name: string; shared: boolean }) => Promise<boolean>
}): JSX.Element {
  const t = useTranslations('search.saved')
  const id = useId()
  const [name, setName] = useState('')
  const [shared, setShared] = useState(false)
  const [busy, setBusy] = useState(false)
  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    const trimmed = name.trim()
    if (!trimmed || busy) return
    setBusy(true)
    const saved = await onSave({ name: trimmed.slice(0, 120), shared })
    setBusy(false)
    if (!saved) return
    setName('')
    setShared(false)
    onOpenChange(false)
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={(event) => void submit(event)}>
          <DialogHeader>
            <DialogTitle>{t('dialogTitle')}</DialogTitle>
            <DialogDescription>{t('dialogDescription')}</DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor={`${id}-name`}>{t('name')}</FieldLabel>
              <Input id={`${id}-name`} value={name} placeholder={t('namePlaceholder')} onChange={(event) => setName(event.target.value)} autoFocus data-testid="saved-search-name" />
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
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              {t('cancel')}
            </Button>
            <Button type="submit" disabled={!name.trim() || busy} aria-busy={busy || undefined} data-testid="saved-search-confirm">
              {t('confirm')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
