'use client'

/**
 * The Unterlagen picker: a dialog over the thread, never a pane beside it.
 *
 * Two uses of one list. On the Rechercheplan card (`mode="pick"`) every row
 * can be named as Grundlage — read in full — or as Ausgeschlossen — never
 * used — and the choice travels with the approval. On a running block
 * (`mode="add"`) a row is added to the Grundlage and the run plans it next.
 *
 * The list is whatever the caller can name: the plan card's fence carries the
 * turn's inventory, the block fetches the project's listing. A row's label is
 * its title when it has one, else its file name — the name is what the run is
 * told, the title is what the reader recognises.
 */

import { useMemo, useState, type FC } from 'react'
import { BookOpen, Ban, Lock, Plus, Search } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Chip } from '@/components/ui/chip'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { asShelf, type Shelf } from '@/lib/source-kinds'
import { useTranslations } from '@/i18n'
import { runsCopy } from '@/i18n/namespaces/runs'
import { planDocumentLabel, type PlanDocument } from '@/lib/runs/plan-documents'
import { cn } from '@/lib/utils'

export type DocumentsRole = 'basis' | 'excluded' | null

/** A row the picker lists: a plan document, and whether it may be handed to a run at all. */
export interface PickerDocument extends PlanDocument {
  /**
   * In a folder not every project member may read: shown, so the reader is
   * not left wondering where it went, and never added (ADR-0087).
   */
  restricted?: boolean
}

interface CommonProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** What can be named: the inventory the caller holds. */
  documents: readonly PickerDocument[]
  loading?: boolean
}

export type DocumentsDialogProps = CommonProps &
  (
    | {
        mode: 'pick'
        basis: readonly string[]
        excluded: readonly string[]
        onChange: (next: { basis: string[]; excluded: string[] }) => void
      }
    | {
        mode: 'add'
        /** Already named: a row already on the Grundlage offers no second add. */
        named: readonly string[]
        onAdd: (doc: PlanDocument) => void | Promise<void>
      }
  )

const fold = (name: string): string => name.trim().toLocaleLowerCase()

// asShelf also reads a ledger stored before the rename (`archiv`).
const shelfKey = (shelf: string | undefined): Shelf | null => asShelf(shelf) ?? null

export const DocumentsDialog: FC<DocumentsDialogProps> = (props) => {
  const { open, onOpenChange, documents, loading = false } = props
  const t = useTranslations(runsCopy)
  const [query, setQuery] = useState('')
  const rows = useMemo(() => {
    const needle = fold(query)
    if (!needle) return documents
    return documents.filter(
      (doc) => fold(planDocumentLabel(doc)).includes(needle) || fold(doc.name).includes(needle)
    )
  }, [documents, query])

  const roleOf = (doc: PlanDocument): DocumentsRole => {
    if (props.mode !== 'pick') return null
    const key = fold(doc.name)
    if (props.basis.some((name) => fold(name) === key)) return 'basis'
    if (props.excluded.some((name) => fold(name) === key)) return 'excluded'
    return null
  }

  const setRole = (doc: PlanDocument, role: DocumentsRole): void => {
    if (props.mode !== 'pick') return
    const key = fold(doc.name)
    const basis = props.basis.filter((name) => fold(name) !== key)
    const excluded = props.excluded.filter((name) => fold(name) !== key)
    if (role === 'basis') basis.push(doc.name)
    if (role === 'excluded') excluded.push(doc.name)
    props.onChange({ basis: basis, excluded: excluded })
  }

  const alreadyNamed = (doc: PlanDocument): boolean =>
    props.mode === 'add' && props.named.some((name) => fold(name) === fold(doc.name))

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg" data-testid="documents-dialog">
        <DialogHeader>
          <DialogTitle>
            {props.mode === 'pick' ? t('documents.pickTitle') : t('documents.addTitle')}
          </DialogTitle>
          <DialogDescription>
            {props.mode === 'pick' ? t('documents.pickDescription') : t('documents.addDescription')}
          </DialogDescription>
        </DialogHeader>
        <div className="relative">
          <Search
            className="text-muted-foreground pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2"
            aria-hidden
          />
          <Input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('documents.searchPlaceholder')}
            aria-label={t('documents.search')}
            className="h-9 pl-8"
          />
        </div>
        <ul
          className="border-border divide-border max-h-80 divide-y overflow-y-auto rounded-md border"
          aria-label={t('documents.list')}
          data-testid="documents-list"
        >
          {loading && rows.length === 0 && (
            <li className="text-muted-foreground px-3 py-6 text-center text-sm">
              {t('documents.loading')}
            </li>
          )}
          {!loading && rows.length === 0 && (
            <li className="text-muted-foreground px-3 py-6 text-center text-sm">
              {t('documents.empty')}
            </li>
          )}
          {rows.map((doc) => {
            const role = roleOf(doc)
            const shelf = shelfKey(doc.shelf)
            return (
              <li
                key={doc.name}
                className="flex items-center gap-2 px-3 py-2"
                data-testid="documents-row"
                data-role={role ?? undefined}
              >
                <span className="min-w-0 flex-1">
                  <span className="text-foreground block truncate text-sm" title={doc.name}>
                    {planDocumentLabel(doc)}
                  </span>
                  {shelf && (
                    <span className="text-muted-foreground text-[11px]">
                      {t(`documents.shelf.${shelf}`)}
                    </span>
                  )}
                </span>
                {props.mode === 'pick' ? (
                  <span className="flex shrink-0 gap-1" role="group" aria-label={planDocumentLabel(doc)}>
                    <button
                      type="button"
                      aria-pressed={role === 'basis'}
                      aria-label={t('documents.markRead', { name: planDocumentLabel(doc) })}
                      onClick={() => setRole(doc, role === 'basis' ? null : 'basis')}
                      className={cn(
                        'focus-visible:ring-ring/60 rounded-md focus-visible:outline-none focus-visible:ring-2'
                      )}
                    >
                      <Chip size="sm" variant={role === 'basis' ? 'default' : 'outline'}>
                        <BookOpen className="size-3" aria-hidden />
                        {t('documents.read')}
                      </Chip>
                    </button>
                    <button
                      type="button"
                      aria-pressed={role === 'excluded'}
                      aria-label={t('documents.markExcluded', { name: planDocumentLabel(doc) })}
                      onClick={() =>
                        setRole(doc, role === 'excluded' ? null : 'excluded')
                      }
                      className="focus-visible:ring-ring/60 rounded-md focus-visible:outline-none focus-visible:ring-2"
                    >
                      <Chip size="sm" variant={role === 'excluded' ? 'destructive' : 'outline'}>
                        <Ban className="size-3" aria-hidden />
                        {t('documents.exclude')}
                      </Chip>
                    </button>
                  </span>
                ) : alreadyNamed(doc) ? (
                  <Chip size="sm" variant="muted">
                    {t('documents.alreadyNamed')}
                  </Chip>
                ) : doc.restricted ? (
                  <Chip
                    size="sm"
                    variant="muted"
                    title={t('documents.restrictedReason')}
                    aria-label={`${t('documents.restricted')}: ${t('documents.restrictedReason')}`}
                    data-testid="documents-restricted"
                  >
                    <Lock className="size-3" aria-hidden />
                    {t('documents.restricted')}
                  </Chip>
                ) : (
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 gap-1 px-2 text-xs"
                    onClick={() => {
                      void props.onAdd(doc)
                      onOpenChange(false)
                    }}
                    aria-label={t('documents.addOne', { name: planDocumentLabel(doc) })}
                  >
                    <Plus className="size-3.5" aria-hidden />
                    {t('documents.add')}
                  </Button>
                )}
              </li>
            )
          })}
        </ul>
        {props.mode === 'pick' && (
          <DialogFooter>
            <Button size="sm" onClick={() => onOpenChange(false)}>
              {t('documents.done')}
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  )
}
