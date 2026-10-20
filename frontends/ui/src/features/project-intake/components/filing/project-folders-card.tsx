'use client'

import type { JSX } from 'react'
import { Folder, Plus } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { useTranslations } from '@/i18n'
import { cn } from '@/lib/utils'
import type { AccessRow } from './access-panel'
import { FilingCard } from './filing-atoms'
import { FolderDropTarget } from './folder-drop-area'

const ROW = 'border-border/60 flex min-h-11 items-center gap-2.5 border-t px-4 text-sm md:min-h-[42px]'

/**
 * The Ablage once documents are in the project: the card the tree stood in,
 * now with the project's top folders as Dateien has them (a restricted one
 * says so), and, while the project takes documents, a last row that chooses
 * more folders. A folder dropped on the card becomes a tree to confirm.
 */
export function ProjectFoldersCard({
  rows,
  documents,
  onAddMore,
  onFiles,
}: {
  rows: readonly AccessRow[]
  documents: number
  /** Choose more folders; absent when the project takes no more documents. */
  onAddMore?: () => void
  onFiles: (files: File[]) => void
}): JSX.Element {
  const t = useTranslations('intakeFilingStep')
  return (
    <FolderDropTarget onFiles={onFiles} disabled={!onAddMore}>
      <FilingCard aria-label={t('project.label')} data-testid="filing-project-folders">
        <div className={cn(ROW, 'bg-muted/40 rounded-t-[14px] border-t-0 font-medium')}>
          <span className="min-w-0 truncate">{t('project.inProject')}</span>
          <span className="text-muted-foreground ml-auto text-xs font-normal tabular-nums">
            {t('project.documents', { count: documents })}
          </span>
        </div>
        <ul>
          {rows.map((row) => (
            <li key={row.path} className={ROW} data-testid="filing-project-folder" data-path={row.path}>
              <Folder className="text-muted-foreground size-4 shrink-0" aria-hidden />
              <span className="min-w-0 truncate">{row.name}</span>
              {row.folder?.ownAccess && (
                <Badge variant="secondary" className="rounded-full font-normal">
                  {t('project.restricted')}
                </Badge>
              )}
            </li>
          ))}
          {rows.length === 0 && <li className={cn(ROW, 'text-muted-foreground')}>{t('project.noFolders')}</li>}
        </ul>
        {onAddMore && (
          <button
            type="button"
            onClick={onAddMore}
            className={cn(
              ROW,
              'text-muted-foreground hover:text-foreground hover:bg-muted/40 focus-visible:ring-ring/60 w-full rounded-b-[14px] text-left focus-visible:outline-none focus-visible:ring-2'
            )}
          >
            <Plus className="size-4 shrink-0" aria-hidden />
            {t('project.addMore')}
          </button>
        )}
      </FilingCard>
    </FolderDropTarget>
  )
}
