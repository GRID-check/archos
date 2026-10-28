'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ProjectUploadScreeningState } from '@/adapters/api/project-upload-screening-client'
import type { FolderItem } from '@/features/documents/file-types'
import { applyProjectOverride, type ProjectScreeningOverride } from '@/lib/upload-screening/project-policy'
import type { UploadScreeningPolicy } from '@/lib/upload-screening/policy'
import type { ExclusionReason } from './default-exclusions'
import type { FilingSetupClient } from './filing-client'
import {
  buildChosenTree,
  chosenFiles,
  previewScreening,
  proposedExclusions,
  summarizeChoice,
  toggleFolder,
  type ChoiceSummary,
  type ChosenTree,
  type ScreeningPreview,
} from './folder-tree'

export interface FilingChoice {
  tree: ChosenTree
  excluded: ReadonlySet<string>
  proposed: ReadonlyMap<string, ExclusionReason>
  summary: ChoiceSummary
}

/**
 * The Ablage step's state: the project's list and folders as the server has
 * them, the folder choice not yet sent, and a draft of the project's terms.
 * The screening preview is computed from the draft when there is one, so the
 * tree shows a change's effect before it is saved.
 */
export function useFilingSetup({
  projectId,
  client,
  initialChoice,
}: {
  projectId: string
  client: FilingSetupClient
  /** A choice to open on (the `/dev` preview); none by default. */
  initialChoice?: readonly File[]
}) {
  const [screening, setScreening] = useState<ProjectUploadScreeningState | null>(null)
  const [screeningFailed, setScreeningFailed] = useState(false)
  const [folders, setFolders] = useState<FolderItem[]>([])
  const [foldersFailed, setFoldersFailed] = useState(false)
  const [initial] = useState(() => {
    if (!initialChoice?.length) return null
    const opened = buildChosenTree(initialChoice)
    return { tree: opened, proposed: proposedExclusions(opened) }
  })
  const [tree, setTree] = useState<ChosenTree | null>(initial?.tree ?? null)
  const [excluded, setExcluded] = useState<ReadonlySet<string>>(() => new Set(initial?.proposed.keys() ?? []))
  const [proposed, setProposed] = useState<ReadonlyMap<string, ExclusionReason>>(initial?.proposed ?? new Map())
  const [draft, setDraft] = useState<ProjectScreeningOverride | null>(null)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let live = true
    setScreeningFailed(false)
    client.loadScreening(projectId).then(
      (state) => live && setScreening(state),
      () => live && setScreeningFailed(true)
    )
    return () => {
      live = false
    }
  }, [client, projectId, attempt])

  const reloadFolders = useCallback(() => {
    client.listFolders(projectId).then(
      (list) => {
        setFolders(list)
        setFoldersFailed(false)
      },
      () => setFoldersFailed(true)
    )
  }, [client, projectId])
  useEffect(reloadFolders, [reloadFolders])

  const choose = useCallback((files: readonly File[]) => {
    const next = buildChosenTree(files)
    const proposals = proposedExclusions(next)
    setTree(next)
    setProposed(proposals)
    setExcluded(new Set(proposals.keys()))
  }, [])

  const discard = useCallback(() => {
    setTree(null)
    setExcluded(new Set())
    setProposed(new Map())
  }, [])

  const toggle = useCallback(
    (path: string) => {
      if (tree) setExcluded((current) => toggleFolder(tree, current, path))
    },
    [tree]
  )

  const saveScreening = useCallback(
    async (override: ProjectScreeningOverride): Promise<boolean> => {
      try {
        setScreening(await client.saveScreening(projectId, override))
        return true
      } catch {
        return false
      }
    },
    [client, projectId]
  )

  /** The policy the preview screens with: the draft's, else the project's. */
  const policy: UploadScreeningPolicy | null = useMemo(() => {
    if (!screening) return null
    return draft ? applyProjectOverride(screening.office, draft) : screening.policy
  }, [screening, draft])

  const choice: FilingChoice | null = useMemo(
    () => (tree ? { tree, excluded, proposed, summary: summarizeChoice(tree, excluded) } : null),
    [tree, excluded, proposed]
  )
  const preview: ScreeningPreview | null = useMemo(
    () => (tree && policy ? previewScreening(tree, excluded, policy) : null),
    [tree, excluded, policy]
  )
  const filesToSend = useCallback(() => (tree ? chosenFiles(tree, excluded).map((entry) => entry.file) : []), [tree, excluded])

  return {
    screening,
    screeningFailed,
    retryScreening: () => setAttempt((count) => count + 1),
    folders,
    foldersFailed,
    reloadFolders,
    choice,
    choose,
    discard,
    toggle,
    filesToSend,
    preview,
    draft,
    setDraft,
    saveScreening,
  }
}
