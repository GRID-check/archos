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
import { useTranslations } from '@/i18n'
import { folderPathKey } from '@/lib/projects/folders'
import { IntakeSection } from '../intake-atoms'
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

export interface AccessPanelProps {
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
 * Wer welchen Ordner öffnen darf: each top folder with who opens it, and the
 * way to change it in the access dialog Dateien uses (ADR-0088, ADR-0097). A
 * folder the choice would create can be restricted before its files arrive:
 * it is created first, exactly as the upload would create it, so its documents
 * are read into the restricted collection from the start rather than moved
 * there afterwards.
 */
export function AccessPanel({
  projectId,
  rows,
  canManage,
  loadFailed,
  ensureFolder,
  onChanged,
}: AccessPanelProps): JSX.Element | null {
  const t = useTranslations('intakeFilingStep')
  const [dialogFolder, setDialogFolder] = useState<FolderItem | null>(null)
  const [creating, setCreating] = useState<string | null>(null)

  if (rows.length === 0 && !loadFailed) return null

  const restrict = async (row: AccessRow): Promise<void> => {
    setCreating(row.path)
    try {
      const folder = await ensureFolder(row.path)
      onChanged()
      setDialogFolder(folder)
    } catch {
      toast.error(t('access.ensureError'))
    } finally {
      setCreating(null)
    }
  }

  return (
    <IntakeSection label={t('access.heading')} description={t('access.description')} testId="filing-access">
      {loadFailed && <p className="text-muted-foreground text-sm">{t('access.loadError')}</p>}
      {rows.length > 0 && (
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
                        onClick={() => setDialogFolder(row.folder)}
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
      )}
      {!canManage && <p className="text-muted-foreground text-xs">{t('access.readOnly')}</p>}
      <FolderAccessDialog
        open={dialogFolder !== null}
        onOpenChange={(open) => {
          if (!open) setDialogFolder(null)
        }}
        projectId={projectId}
        folder={dialogFolder}
        onSaved={() => {
          // The dialog says what it saved and moved; the list reads it again.
          setDialogFolder(null)
          onChanged()
        }}
      />
    </IntakeSection>
  )
}
