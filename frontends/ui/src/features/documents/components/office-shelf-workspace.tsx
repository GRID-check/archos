'use client'

import { useCallback, useMemo, type ReactNode } from 'react'
import { Archive, Search } from 'lucide-react'
import { sourceTint } from '@/lib/ui/source-tint'
import { CountPill } from '@/components/ui/count-pill'
import { useTranslations } from '@/i18n'
import { createDocumentNameProbeClient } from '@/lib/documents/name-probe-client'
import { inferDocumentKind } from '../document-kind'
import type { FileItem } from '../file-types'
import { useOfficeShelfDocuments } from '../hooks/use-office-shelf-documents'
import { OFFICE_SHELF_ENDPOINTS, type CardExtras, type FileShelf } from '../lib/file-shelf'
import { FileWorkspace } from './file-workspace'
import { SearchWorkspace, ShelfSearchBack, ShelfSearchToggle, useShelfSearchMode } from '@/features/search'

interface OfficeShelfWorkspaceProps {
  /** Whether the viewer may change the Archiv (holds `org:office_shelf:manage`). */
  canManage: boolean
  /** Whether an `.ifc` here can reach the model workspace (`ifc-models`). */
  showModels?: boolean
  /**
   * Controls appended at the end of the identity row, after the upload button.
   * The Archiv sheet slots its close control here so the workspace's own
   * header stays the sheet's ONE header instead of gaining a twin above it.
   */
  trailingActions?: ReactNode
}

/**
 * Gold Büroablage identity mark (spec §4, `--source-office`): icon + label
 * together so color is never the only carrier (a11y).
 */
const OFFICE_TINT = sourceTint('office')

/**
 * The office Archiv: {@link FileWorkspace} over the organization's shelf.
 *
 * It is a project's Dateien with the project taken out. What it adds is the
 * office's own identity — the gold mark, name and count, the sheet's close
 * control — and the permission model: a member without `org:office_shelf:manage` gets
 * the read-only view (list, folders, search, filters, preview, download).
 * There is no assignment (collaboration is project-scoped) and no „Frage zur
 * Datei" (there is no project chat to ask in).
 */
export function OfficeShelfWorkspace({
  canManage,
  showModels = false,
  trailingActions,
}: OfficeShelfWorkspaceProps) {
  const t = useTranslations('officeShelf')
  const tSearch = useTranslations('search.mode')
  const probe = useMemo(() => createDocumentNameProbeClient(), [])
  // „Suche“ in place of the listing (`?mode=search`), scoped to the shelf and the open folder.
  const search = useShelfSearchMode()

  /** The gold kind chip, and where the document came from when it says. */
  const cardExtras = useCallback(
    (file: FileItem): CardExtras => {
      const kind = inferDocumentKind(file)
      const provenance = (file.tags ?? []).slice(0, 3).join(' · ')
      const line = t('library.provenance', { source: provenance })
      return {
        source: 'office',
        sourceLabel: t(`library.kind.${kind}` as 'library.kind.document'),
        ...(provenance !== ''
          ? {
              footerLead: (
                <span
                  className="text-muted-foreground/80 min-w-0 flex-1 truncate"
                  data-testid="office-shelf-provenance"
                  title={line}
                >
                  {line}
                </span>
              ),
            }
          : {}),
      }
    },
    [t]
  )

  const shelf: FileShelf = {
    source: 'office',
    documentScope: 'officeShelf',
    endpoints: OFFICE_SHELF_ENDPOINTS,
    projectId: null,
    canManage,
    canCollaborate: false,
    // Only managers drive the upload engine; no collection for a read-only
    // viewer keeps its orchestrator effects inert (no background calls that
    // would 403 for them anyway).
    useUpload: ({ collectionName, folderId, onComplete }) =>
      useOfficeShelfDocuments({
        collectionName: canManage ? collectionName : undefined,
        folderId,
        onComplete,
      }),
    probeNames: probe.officeShelf,
    probeRevisions: probe.officeShelfRevisions,
    preview: { kind: 'dialog' },
    cardExtras,
    messages: {
      dropToUpload: t('workspace.dropToUpload'),
      ingestionComplete: (name) => t('toast.ingestionComplete', { name }),
    },
    showModels,
  }

  if (search.active) {
    return (
      <SearchWorkspace
        surface={{ kind: 'office_shelf', folderId: search.folderId }}
        inset
        autoFocus
        leading={
          <>
            <ShelfSearchBack onClose={search.close} label="backToShelf" />
            {trailingActions}
          </>
        }
      />
    )
  }

  return (
    <FileWorkspace
      shelf={shelf}
      headerLeading={<ShelfSearchToggle onOpen={search.open} />}
      moreEntries={[{ type: 'item', id: 'search', label: tSearch('open'), icon: Search, onSelect: search.open, testId: 'shelf-search-open-more' }]}
      renderHeader={(controls, { count }) => (
        // Identity row — the gold Büroablage mark, the name of the store, and
        // how much is in it. The count sits with the title: it is a property of
        // the Archiv, and the one number a reader wants before they filter.
        <div className="flex min-h-[4rem] flex-wrap items-center gap-x-4 gap-y-2 border-b px-4 py-3.5">
          {/* Phone: the identity and the sheet's close share the first line (the
              close is the thumb's way out, so it stays at the top right), and
              the controls take the line under them at the full width, where
              the search can be a field instead of a sliver. From `sm` the
              three sit in one row, as they always did. */}
          <div className="flex min-w-0 items-center gap-3 max-sm:flex-1 max-sm:basis-0">
            <span
              className="shadow-2xs flex size-9 shrink-0 items-center justify-center rounded-xl"
              style={OFFICE_TINT}
              aria-hidden
            >
              <Archive className="size-[18px]" />
            </span>
            <div className="min-w-0">
              <div className="flex min-w-0 items-center gap-2">
                <h2 className="text-foreground truncate text-sm font-semibold tracking-tight">{t('title')}</h2>
                <span className="inline-flex h-5 min-w-5 shrink-0 items-center justify-center">
                  {count !== null && count > 0 && (
                    <CountPill data-testid="office-shelf-document-count" count={count} />
                  )}
                </span>
              </div>
              <p className="text-muted-foreground truncate text-xs">{t('subtitle')}</p>
            </div>
          </div>
          {/* `max-w-full` is what keeps this inside the card: the controls group
              is `shrink-0`, so its flex basis is its whole single-line width
              (627px with the search and the upload button), and only a max
              width can cap a basis the item refuses to shrink below. */}
          <div
            className="flex min-w-0 max-w-full items-center justify-end gap-2 max-sm:order-3 max-sm:w-full sm:ml-auto [&>*]:max-w-full"
            data-testid="office-shelf-controls"
          >
            {controls}
          </div>
          {trailingActions && <div className="flex shrink-0 items-center max-sm:order-2">{trailingActions}</div>}
        </div>
      )}
    />
  )
}
