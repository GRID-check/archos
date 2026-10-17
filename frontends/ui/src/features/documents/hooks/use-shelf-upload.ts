'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useTranslations } from '@/i18n'
import type { FolderItem } from '../file-types'
import { takeDroppedFiles } from '../lib/dropped-file-handover'
import { filesToUpload, samePlanOutcome, type FolderUploadPlan, type PlannedMove } from '../lib/folder-upload-plan'
import { isZipArchive } from '../lib/zip-types'
import type { FileShelf, ShelfEndpoints, ShelfUploadApi } from '../lib/file-shelf'
import { useUploadDecision, type SettledPlan } from './use-upload-decision'
import { UploadScreeningPolicyUnavailableError } from '@/adapters/api/upload-screening-policy'

export interface ShelfUploadOptions {
  shelf: Pick<FileShelf, 'probeNames' | 'probeFassungen' | 'handoverKey'> & { endpoints: Pick<ShelfEndpoints, 'folders'> }
  upload: Pick<ShelfUploadApi, 'uploadFiles'>
  folders: readonly FolderItem[]
  foldersReady: boolean
  selectedFolderId: string | null
  loadFolders: () => Promise<unknown>
  loadFiles: (quiet?: boolean) => Promise<unknown>
  /** An upload is running (this shelf's or another's): a new drop waits for it rather than racing it. */
  uploading?: boolean
}

/** Where an upload lands, and what a drop could not hand over. */
export interface UploadTarget {
  /** The folder the files land in; absent is the folder on screen, `null` the top level. */
  folderId?: string | null
  /** What the drop could not read (`useFileDragDrop`'s `DropInfo`), for the reader to be told. */
  info?: { truncated: boolean; unreadable: number }
}

/** One drop waiting for the shelf to be ready for it. */
interface QueuedDrop {
  files: File[]
  folderId: string | null
}

/*
 * A FOLDER IS NOT A LONGER LIST OF FILES.
 *
 * Every upload on a shelf — the button, the folder item in its menu, the dashed
 * tile, a drop onto the workspace — comes through `handleUpload`, and this is
 * where the two gestures part company. A handful of picked files goes straight
 * to `uploadFiles`. A directory tree does not: it carries a structure, it
 * usually overlaps what is already on the shelf, and applying it silently was
 * costing work: the tree collapsed into whichever folder the reader stood in,
 * same-name files replaced live documents without saying so, and two files of
 * one name inside one drop both uploaded, one overwriting the other.
 *
 * Loose files take the same plan. A file whose name the shelf already holds
 * becomes a new Fassung of that document (ADR-0054), so it asks „Neue Fassung
 * von „X“?" — decided by asking the server by name (`probeNames`), never from
 * what this browser happens to have loaded.
 *
 * A file whose name continues a document already on the shelf (index or date in
 * the name, newer than it) is offered „Als neue Fassung von X ablegen" in the
 * same dialog, decided with `fassungOffers: probeFassungen` and sent as `fassungOf`
 * (ADR-0099).
 *
 * Every path is screened against the office's sensitive-data list (ADR-0086),
 * on both shelves: the plan shows what the screening holds back and takes the
 * reader's releases, and each upload names the folder it lands in so the
 * browser and the server screen the same path.
 */
export function useShelfUpload({
  shelf,
  upload,
  folders,
  foldersReady,
  selectedFolderId,
  loadFolders,
  loadFiles,
  uploading = false,
}: ShelfUploadOptions) {
  const t = useTranslations('files')
  const decision = useUploadDecision()
  const { propose, setReleased, settle, changeFassung, plan, setOpen, setPending } = decision
  const { uploadFiles } = upload
  const { probeNames, probeFassungen, handoverKey } = shelf
  const ensureUrl = `${shelf.endpoints.folders}/ensure`

  /**
   * The path of the folder the reader stands in, from the shelf root, or null
   * at the root. The upload screening reads it (ADR-0086): a scan dropped into
   * „Honorare" is screened as a fee document whatever its own name.
   */
  const currentFolderPath = useMemo(
    () => (selectedFolderId ? (folders.find((folder) => folder.id === selectedFolderId)?.path ?? null) : null),
    [folders, selectedFolderId]
  )
  const pathOf = useCallback(
    (folderId: string | null) => (folderId ? (folders.find((folder) => folder.id === folderId)?.path ?? null) : null),
    [folders]
  )

  /**
   * The folder the upload in progress lands in, and its path: where the reader
   * stood when they dropped, or the folder they dropped ON. Everything after
   * the drop (the folders a tree creates, where it lands, the moves of a
   * re-sync, the screening's path) reads this, never `selectedFolderId`: the
   * reader may have walked elsewhere while the plan dialog was open, and a drop
   * on the „Planung" tile was never meant for the folder on screen.
   */
  const base = useRef<{ folderId: string | null; path: string | null }>({ folderId: null, path: null })

  /**
   * A ZIP is unpacked first and then goes through exactly what a dropped folder
   * does. The unzip library is loaded only when there is one to unpack: most
   * uploads are PDFs, and the chat's bundle never needed it.
   */
  const unpackArchives = useCallback(
    async (incoming: File[]): Promise<File[]> => {
      if (!incoming.some(isZipArchive)) return incoming
      const reading = toast.loading(t('zip.reading'))
      try {
        const { expandZips } = await import('../lib/expand-zip')
        const { files, notes } = await expandZips(incoming)
        for (const note of notes) toast.error(t(`zip.${note.reason}`, { name: note.zip, limit: note.limit }))
        return files
      } finally {
        toast.dismiss(reading)
      }
    },
    [t]
  )

  /**
   * Plan one drop (or pick) and send it, against the folder it was meant for.
   * Resolves when it has gone straight to the upload or the plan dialog has
   * opened for it.
   */
  const proposeDrop = useCallback(
    (drop: QueuedDrop): Promise<void> => {
      const target = { folderId: drop.folderId, path: pathOf(drop.folderId) }
      base.current = target
      return unpackArchives(drop.files)
        .then((files) => {
          if (files.length === 0) return undefined
          return propose(
            {
              files,
              documents: probeNames,
              fassungOffers: probeFassungen,
              folders,
              currentFolderId: target.folderId,
              screeningBasePath: target.path,
            },
            (direct) =>
              void uploadFiles(direct, { folderIdFor: () => target.folderId, folderPathFor: () => target.path })
          )
        })
        .catch((error: unknown) => {
          toast.error(
            error instanceof UploadScreeningPolicyUnavailableError
              ? t('errors.screeningPolicyUnavailable')
              : t('folderUpload.compareError')
          )
        })
    },
    [unpackArchives, propose, probeNames, probeFassungen, uploadFiles, folders, pathOf, t]
  )

  /*
   * ONE DROP AT A TIME, AND NONE LOST.
   *
   * A drop used to be refused while anything was uploading (the zone simply
   * went dead, and the files with it, without a word), and a second drop made
   * while the first was still being compared with the shelf replaced the
   * first, which then never went. A drop before the folders were loaded was
   * planned against no folders at all: every folder of a dropped tree counted
   * as new, and a read-only folder took files the server then refused.
   *
   * Now a drop that comes while the shelf is busy waits in this queue, the
   * reader is told it will follow, and it goes when the shelf is free: no
   * upload running, no plan being made or shown, the folders loaded.
   */
  const queue = useRef<QueuedDrop[]>([])
  const [queued, setQueued] = useState(0)
  const [proposing, setProposing] = useState(false)
  const busy = proposing || decision.open || decision.pending || uploading || !foldersReady

  const handleUpload = useCallback(
    (incoming: File[], target: UploadTarget = {}) => {
      const { info } = target
      if (info?.truncated) toast.warning(t('workspace.dropTruncated', { count: incoming.length }))
      if (info && info.unreadable > 0) toast.warning(t('workspace.dropUnreadable', { count: info.unreadable }))
      if (incoming.length === 0) return
      const drop: QueuedDrop = { files: incoming, folderId: target.folderId === undefined ? selectedFolderId : target.folderId }
      if (busy || queue.current.length > 0) {
        queue.current.push(drop)
        setQueued(queue.current.length)
        // Only when there is something to wait FOR: a page still loading its
        // folders is a moment, not an upload.
        if (foldersReady) toast.info(t('workspace.dropQueued'))
        return
      }
      setProposing(true)
      void proposeDrop(drop).finally(() => setProposing(false))
    },
    [busy, foldersReady, selectedFolderId, proposeDrop, t]
  )

  // The next queued drop, the moment the shelf is free for it.
  useEffect(() => {
    if (busy || queued === 0) return
    const next = queue.current.shift()
    setQueued(queue.current.length)
    if (!next) return
    setProposing(true)
    void proposeDrop(next).finally(() => setProposing(false))
  }, [busy, queued, proposeDrop])

  /** A release asks the name probe about the file; when it cannot, the file stays held back and the reader is told. */
  const onReleaseChange = useCallback(
    (file: File, released: boolean) => {
      setReleased(file, released).catch(() => toast.error(t('folderUpload.compareError')))
    },
    [setReleased, t]
  )

  // A drop elsewhere in the app brought the reader here (`ProjectFileDrop`).
  // Taken once, and not before the folders are in: a dropped tree is planned
  // against them, and an empty list would rebuild folders the shelf already has.
  useEffect(() => {
    if (!handoverKey || !foldersReady) return
    const handedOver = takeDroppedFiles(handoverKey)
    if (handedOver.length > 0) handleUpload(handedOver)
  }, [handoverKey, handleUpload, foldersReady])

  /** The folders first and in ONE request: forty creates would be forty chances to end with half a tree. Nothing uploads if it fails. */
  const ensureFolders = useCallback(
    async (paths: string[]): Promise<Record<string, string> | null> => {
      if (paths.length === 0) return {}
      try {
        const res = await fetch(ensureUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ parentId: base.current.folderId, paths }),
        })
        if (!res.ok) throw new Error(`Folders failed (${res.status})`)
        const data = (await res.json()) as { folderIdByPath?: Record<string, string> }
        return data.folderIdByPath ?? {}
      } catch {
        // The dialog STAYS OPEN: nothing was uploaded, the plan is still the
        // plan, and a toast alone would be the only account of a gesture the
        // reader is entitled to simply retry.
        setPending(false)
        toast.error(t('folderUpload.foldersError'))
        return null
      }
    },
    [ensureUrl, setPending, t]
  )

  /**
   * The documents already here, already correct, and filed somewhere the tree
   * does not put them: nothing is uploaded for them, so without this the dialog's
   * promise ("the folder structure is recreated") is false for exactly the files
   * a re-sync is mostly made of. `allSettled`: one refused move must not take
   * the upload down with it; the reload is what tells the truth.
   */
  const applyMoves = useCallback(
    (moves: readonly PlannedMove[], byPath: Record<string, string>) =>
      Promise.allSettled(
        moves.map((move) =>
          fetch(`/api/documents/${move.documentId}/folder`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            // Through the SAME map the uploads resolve through, and only now:
            // the folder may have been created a moment ago.
            body: JSON.stringify({
              folderId: move.targetPath ? (byPath[move.targetPath] ?? base.current.folderId) : base.current.folderId,
            }),
          })
        )
      ),
    []
  )

  /**
   * The plan the reader confirmed, as it may be applied now (`settle`): a
   * release still being asked about answered, and the office's policy read
   * afresh, BEFORE the folders are made, because a folder's name is sent with
   * them. When settling changed what would happen, nothing is sent: the dialog
   * shows the new plan and the reader confirms that one. Null when nothing may
   * go, and the reader has been told why.
   */
  const settlePlan = useCallback(
    async (shown: FolderUploadPlan): Promise<SettledPlan | null> => {
      try {
        const settled = await settle()
        if (!settled) return null
        if (samePlanOutcome(shown, settled.plan)) return settled
        toast.error(t('folderUpload.planChanged'))
      } catch (error) {
        toast.error(
          error instanceof UploadScreeningPolicyUnavailableError
            ? t('errors.screeningPolicyUnavailable')
            : t('folderUpload.compareError')
        )
      }
      return null
    },
    [settle, t]
  )

  const applyFolderPlan = useCallback(
    async (includeUpdates: boolean) => {
      if (!plan) return
      if (filesToUpload(plan, includeUpdates).length === 0 && plan.moves.length === 0) return
      setPending(true)

      const settled = await settlePlan(plan)
      if (!settled) {
        setPending(false)
        return
      }
      const { policy } = settled
      const selected = filesToUpload(settled.plan, includeUpdates)
      const moves = settled.plan.moves

      const byPath = await ensureFolders(settled.plan.folders.map((folder) => folder.path))
      if (byPath === null) return

      try {
        // Per file rather than per batch — that is the point of reproducing the
        // tree. A file at the top of the drop belongs where the reader stands.
        const { folderId: baseFolderId, path: basePath } = base.current
        const folderIdByFile = new Map<File, string | null>()
        for (const planned of selected) {
          folderIdByFile.set(
            planned.file,
            planned.targetPath ? (byPath[planned.targetPath] ?? baseFolderId) : baseFolderId
          )
        }
        // What the server screens each file against: the folder it lands in
        // (ADR-0086), and whether the reader released it in the dialog.
        const plannedByFile = new Map(selected.map((planned) => [planned.file, planned]))
        setOpen(false)
        if (moves.length > 0) await applyMoves(moves, byPath)
        if (selected.length > 0) {
          await uploadFiles(
            selected.map((planned) => planned.file),
            {
              folderIdFor: (file) => folderIdByFile.get(file) ?? null,
              folderPathFor: (file) => {
                const target = plannedByFile.get(file)?.targetPath ?? ''
                return [basePath, target].filter(Boolean).join('/') || null
              },
              screeningReleased: (file) => plannedByFile.get(file)?.screeningReleased === true,
              // The reader's tick on „Als neue Fassung von X ablegen" (ADR-0099): the older
              // document's id, which the server checks again before the link is written.
              fassungOf: (file) => {
                const offer = plannedByFile.get(file)?.fassungOf
                return offer?.chosen ? offer.of.id : null
              },
              // The policy this plan was just settled against: read once, so
              // what the dialog applies and what the upload screens agree.
              screeningPolicy: policy,
              excludedByScreening: settled.plan.files
                .filter((planned) => planned.action === 'excluded')
                .map((planned) => planned.screening ?? []),
            }
          )
        }
        // The tree grew and a move wrote rows this page shows; `uploadFiles`
        // only refreshes the listing when it actually uploaded something.
        await loadFolders()
        await loadFiles(true)
        const counts = { uploaded: String(selected.length), skipped: String(settled.plan.counts.unchanged) }
        // A move-only apply uploads nothing, and „0 Dateien hochgeladen" alone
        // would read as a failed gesture over work that was actually done.
        toast.success(
          moves.length > 0
            ? t('folderUpload.doneMoved', { ...counts, moved: String(moves.length) })
            : t('folderUpload.done', counts)
        )
      } catch {
        toast.error(t('folderUpload.applyError'))
      } finally {
        setPending(false)
      }
    },
    [
      plan,
      uploadFiles,
      loadFolders,
      loadFiles,
      ensureFolders,
      applyMoves,
      settlePlan,
      t,
      setOpen,
      setPending,
    ]
  )

  return { handleUpload, applyFolderPlan, onReleaseChange, onFassungChange: changeFassung, decision }
}
