'use client'

import type { JSX } from 'react'
import { useState } from 'react'
import { Folder, Lock, Users } from 'lucide-react'
import { toast } from 'sonner'
import { BusyButton } from '@/components/ui/busy-button'
import { Button } from '@/components/ui/button'
import { NewMark } from '@/components/ui/filing-chip'
import { Item, ItemActions, ItemContent, ItemDescription, ItemList, ItemMedia, ItemTitle } from '@/components/ui/item'
import { FolderAccessDialog } from '@/features/documents/components/folder-access-dialog'
import type { FolderItem } from '@/features/documents/file-types'
import { useLocale, useTranslations } from '@/i18n'
import { folderPathKey } from '@/lib/projects/folders'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { SummaryBlock } from './filing-atoms'
import type { FolderNode } from './folder-tree'

/** One folder whose access is shown: one the project has, or one the choice would create. */
export interface AccessRow {
  path: string
  name: string
  /** The project's folder; absent while the choice has not created it yet. */
  folder: FolderItem | null
}

/**
 * The folders worth a look, from the project's folders and the choice: the top
 * of the project folder (the subfolders of a single root folder, as the office
 * server's project folder arrives), each once, the project's own first.
 */
export function accessRows(projectFolders: readonly FolderItem[], chosen: readonly FolderNode[]): AccessRow[] {
  const roots = projectFolders.filter((folder) => folder.parentId === null)
  const [onlyRoot] = roots
  const top =
    roots.length === 1 && onlyRoot && projectFolders.some((folder) => folder.parentId === onlyRoot.id)
      ? projectFolders.filter((folder) => folder.parentId === onlyRoot.id)
      : roots
  const rows: AccessRow[] = top.map((folder) => ({ path: folder.path, name: folder.name, folder }))
  const byKey = new Map(projectFolders.map((folder) => [folderPathKey(folder.path), folder]))
  const seen = new Set(rows.map((row) => folderPathKey(row.path)))
  for (const node of chosen) {
    const key = folderPathKey(node.path)
    if (seen.has(key)) continue
    seen.add(key)
    rows.push({ path: node.path, name: node.name, folder: byKey.get(key) ?? null })
  }
  return rows
}

export interface AccessSummaryProps {
  projectId: string
  rows: readonly AccessRow[]
  /** The reader manages the project, so may change who opens a folder. */
  canManage: boolean
  loadFailed: boolean
  /** The folder at this path, created as the upload would create it. */
  ensureFolder: (path: string) => Promise<FolderItem>
  /** A folder's access changed, or a folder was created: read the folders again. */
  onChanged: () => void
}

/**
 * Wer welchen Ordner öffnen darf, as one block of the summary card: whether
 * every folder is open to everyone by project role or which are restricted,
 * and one quiet link to the folders with who opens each (ADR-0088, ADR-0097).
 */
export function AccessSummary(props: AccessSummaryProps): JSX.Element {
  const { rows, canManage, loadFailed } = props
  const t = useTranslations('intakeFilingStep')
  const { locale } = useLocale()
  const [open, setOpen] = useState(false)
  const restricted = rows.filter((row) => row.folder?.ownAccess)
  const names = new Intl.ListFormat(locale, { type: 'conjunction' }).format(restricted.map((row) => row.name))
  const link = restricted.length > 0 ? t('access.manage') : t('access.restrictOne')
  return (
    <>
      <SummaryBlock
        testId="filing-access-summary"
        icon={<Lock className="text-muted-foreground" aria-hidden />}
        title={
          restricted.length > 0 ? t('access.restrictedTitle', { count: restricted.length }) : t('access.everyoneTitle')
        }
        body={loadFailed ? t('access.loadError') : restricted.length > 0 ? t('access.restricted', { names }) : t('access.everyone')}
        action={
          rows.length > 0 && (
            <Button type="button" variant="inline" onClick={() => setOpen(true)}>
              {canManage ? link : t('access.view')}
            </Button>
          )
        }
      />
      <AccessSheet {...props} open={open} onOpenChange={setOpen} />
    </>
  )
}

/**
 * The folders with who opens each, and the way to change it in the access
 * dialog Dateien uses. A folder the choice would create can be restricted
 * before its files arrive: it is created first, exactly as the upload would
 * create it, so its documents are read into the restricted collection from the
 * start rather than moved there afterwards. The sheet steps aside while the
 * dialog is open, so one overlay holds the focus at a time.
 */
function AccessSheet({
  projectId,
  rows,
  canManage,
  ensureFolder,
  onChanged,
  open,
  onOpenChange,
}: AccessSummaryProps & { open: boolean; onOpenChange: (open: boolean) => void }): JSX.Element {
  const t = useTranslations('intakeFilingStep')
  const [dialogFolder, setDialogFolder] = useState<FolderItem | null>(null)
  const [creating, setCreating] = useState<string | null>(null)

  const change = (folder: FolderItem): void => {
    onOpenChange(false)
    setDialogFolder(folder)
  }
  const restrict = async (row: AccessRow): Promise<void> => {
    setCreating(row.path)
    try {
      const folder = await ensureFolder(row.path)
      onChanged()
      change(folder)
    } catch {
      toast.error(t('access.ensureError'))
    } finally {
      setCreating(null)
    }
  }

  return (
    <>
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent side="right" closeLabel={t('access.close')} data-testid="filing-access">
          <SheetHeader>
            <SheetTitle>{t('access.heading')}</SheetTitle>
            <SheetDescription>{t('access.description')}</SheetDescription>
          </SheetHeader>
          <ItemList as="ul">
            {rows.map((row) => {
              const own = row.folder?.ownAccess
              const who = own ? (own.everyoneReads ? t('access.ownEveryoneReads') : t('access.own')) : t('access.inherit')
              return (
                <Item as="li" key={row.path} className="flex-wrap py-2" data-testid="filing-access-row" data-path={row.path}>
                  <ItemMedia className="size-6">
                    {own ? <Lock className="size-4" aria-hidden /> : <Folder className="text-muted-foreground size-4" aria-hidden />}
                  </ItemMedia>
                  <ItemContent>
                    <ItemTitle className="flex items-center gap-2">
                      <span className="truncate">{row.name}</span>
                      {!row.folder && <NewMark>{t('access.newFolder')}</NewMark>}
                    </ItemTitle>
                    <ItemDescription className="flex items-center gap-1">
                      {!own && <Users className="size-3" aria-hidden />}
                      {who}
                    </ItemDescription>
                  </ItemContent>
                  {canManage && (
                    <ItemActions>
                      {row.folder ? (
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          aria-label={t('access.changeAria', { name: row.name })}
                          onClick={() => row.folder && change(row.folder)}
                        >
                          {t('access.change')}
                        </Button>
                      ) : (
                        <BusyButton
                          type="button"
                          size="sm"
                          variant="outline"
                          icon={<Lock aria-hidden />}
                          busy={creating === row.path}
                          blocked={creating !== null}
                          busyLabel={t('access.restrict')}
                          aria-label={t('access.restrictAria', { name: row.name })}
                          onClick={() => void restrict(row)}
                        >
                          {t('access.restrict')}
                        </BusyButton>
                      )}
                    </ItemActions>
                  )}
                </Item>
              )
            })}
          </ItemList>
          {!canManage && <p className="text-muted-foreground text-xs">{t('access.readOnly')}</p>}
        </SheetContent>
      </Sheet>
      <FolderAccessDialog
        open={dialogFolder !== null}
        onOpenChange={(next) => {
          if (!next) setDialogFolder(null)
        }}
        projectId={projectId}
        folder={dialogFolder}
        onSaved={() => {
          // The dialog says what it saved and moved; the summary reads it again.
          setDialogFolder(null)
          onChanged()
        }}
      />
    </>
  )
}
