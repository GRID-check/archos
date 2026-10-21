'use client'

/**
 * The review step of a root sort: the summary, the „nur unsichere“ switch,
 * and the proposal as a tree. Controlled and network-free: the dialog and the
 * `/dev/root-sort` preview render this same body from props, so the preview
 * shows the real review and not a copy of it.
 */

import type { JSX } from 'react'
import { useMemo } from 'react'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
import { useTranslations } from '@/i18n'
import {
  buildPlacementTree,
  retarget,
  setFileKept,
  setFolderKept,
  unsureOnly,
  type PlacementInput,
  type PlacementState,
  type RetargetChoice,
  type FolderNode,
} from '../../lib/placement-tree'
import { PlacementTreeView } from './placement-tree'

export interface RootSortReviewProps {
  input: PlacementInput
  state: PlacementState
  onStateChange: (next: PlacementState) => void
  onlyUnsure: boolean
  onOnlyUnsureChange: (next: boolean) => void
}

export function RootSortReview({
  input,
  state,
  onStateChange,
  onlyUnsure,
  onOnlyUnsureChange,
}: RootSortReviewProps): JSX.Element {
  const t = useTranslations('files')
  const full = useMemo(() => buildPlacementTree(input, state), [input, state])
  const tree = useMemo(() => (onlyUnsure ? unsureOnly(full) : full), [full, onlyUnsure])
  const { summary } = full
  const nothing = summary.sure + summary.unsure === 0

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="success">{t('rootSort.review.sure', { count: summary.sure })}</Badge>
        <Badge variant="warning">{t('rootSort.review.unsure', { count: summary.unsure })}</Badge>
        <Badge variant="info">
          {t('rootSort.review.newFolders', { count: summary.newFolders })}
        </Badge>
        <Badge variant="secondary">{t('rootSort.review.stays', { count: summary.stays })}</Badge>
        <label className="ml-auto flex items-center gap-2 text-sm">
          <Switch checked={onlyUnsure} onCheckedChange={onOnlyUnsureChange} />
          {t('rootSort.review.onlyUnsure')}
        </label>
      </div>
      <p className="text-muted-foreground text-sm">{t('rootSort.review.hint')}</p>
      {nothing ? (
        <p className="text-muted-foreground border-border rounded-lg border border-dashed px-4 py-8 text-center text-sm">
          {t('rootSort.review.empty')}
        </p>
      ) : (
        <>
          {onlyUnsure && tree.folders.length === 0 && (
            <p className="text-muted-foreground text-sm">{t('rootSort.review.onlyUnsureEmpty')}</p>
          )}
          <PlacementTreeView
            tree={tree}
            folders={input.folders}
            onlyUnsure={onlyUnsure}
            onToggleFile={(documentId, kept) => onStateChange(setFileKept(state, documentId, kept))}
            onToggleFolder={(node: FolderNode, kept) =>
              onStateChange(setFolderKept(state, node, kept))
            }
            onRetarget={(documentId: string, choice: RetargetChoice) =>
              onStateChange(retarget(state, documentId, choice))
            }
          />
        </>
      )}
      {summary.newFolders > 0 && (
        <p className="text-muted-foreground text-xs">{t('rootSort.review.newFoldersNote')}</p>
      )}
    </div>
  )
}
