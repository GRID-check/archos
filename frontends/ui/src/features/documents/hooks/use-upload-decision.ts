'use client'

import { isSystemFile } from '../lib/system-files'
import { useCallback, useRef, useState } from 'react'
import { loadUploadScreeningPolicy } from '@/adapters/api/upload-screening-policy'
import type { UploadScreeningPolicy } from '@/lib/upload-screening/policy'
import { digestFiles } from '../lib/content-digest'
import type { FassungCandidateMatch } from '@/lib/documents/name-probe-types'
import type { FassungChange } from '../lib/fassung-proposals'
import {
  buildFolderUploadPlan,
  continuesASeries,
  isFolderUpload,
  needsUploadDecision,
  type FolderUploadPlan,
  type FolderUploadPlanInput,
  type PlanDocument,
} from '../lib/folder-upload-plan'

/**
 * Where the plan's documents come from: a list the caller already has, or —
 * what both shelves use — a probe asked with the dropped names
 * (`name-probe-client.ts`), which answers from the database what the upload
 * will match, whatever the browser happens to have loaded.
 */
export type PlanDocumentSource =
  | readonly PlanDocument[]
  | ((names: readonly string[]) => Promise<readonly PlanDocument[]>)

/**
 * Where the offers „Als neue Fassung von X ablegen" come from: a probe asked
 * with the dropped names (`name-probe-client.ts`, ADR-0097), answering for the
 * names that continue a document on the shelf.
 */
export type FassungOfferSource = (names: readonly string[]) => Promise<readonly FassungCandidateMatch[]>

/** What the dialog is about: a directory tree, or files picked or dropped loose. */
export type UploadDecisionKind = 'folder' | 'files'

/**
 * The documents the plan compares against: the caller's list, or the probe
 * asked with these files' names only. No file, no request.
 */
async function documentsFor(source: PlanDocumentSource, files: readonly File[]): Promise<readonly PlanDocument[]> {
  if (typeof source !== 'function') return source
  if (files.length === 0) return []
  return source([...new Set(files.map((file) => file.name))])
}

/**
 * What these files continue on the shelf. Only names that read as part of a
 * revision series are asked about, so an ordinary drop makes no request. An
 * offer is a convenience, never a gate: when the probe cannot answer, the files
 * are planned without one and upload as they always did.
 */
async function offersFor(
  source: FassungOfferSource | undefined,
  files: readonly File[],
): Promise<readonly FassungCandidateMatch[]> {
  const names = [...new Set(files.map((file) => file.name).filter(continuesASeries))]
  if (!source || names.length === 0) return []
  try {
    return await source(names)
  } catch {
    return []
  }
}

/** The input with these offers added; a later answer for the same name replaces the earlier. */
function withOffers(input: FolderUploadPlanInput, found: readonly FassungCandidateMatch[]): FolderUploadPlanInput {
  if (found.length === 0) return input
  return {
    ...input,
    fassungOffers: new Map([...(input.fassungOffers ?? []), ...found.map((offer) => [offer.name, offer] as const)]),
  }
}

/** The input with these documents added, each once: two answers about one name must not list it twice. */
function withDocuments(input: FolderUploadPlanInput, found: readonly PlanDocument[]): FolderUploadPlanInput {
  const known = new Set(input.documents.map((document) => document.id))
  return { ...input, documents: [...input.documents, ...found.filter((document) => !known.has(document.id))] }
}

/** What a confirmed plan may send, read once the plan is settled: see {@link UploadDecision.settle}. */
export interface SettledPlan {
  plan: FolderUploadPlan
  /** The office's policy as read for this apply; the upload screens with it rather than reading it again. */
  policy: UploadScreeningPolicy
}

export interface UploadDecision {
  /**
   * Plan an upload against the shelf and either send it straight away
   * (`sendDirect`) or open the dialog. A function source is called with the
   * dropped names, so the comparison is against every document the upload
   * could touch rather than against the page of the listing on screen.
   */
  propose: (
    input: Omit<
      FolderUploadPlanInput,
      'documents' | 'digests' | 'screening' | 'fassungOffers' | 'fassungChoices'
    > & {
      documents: PlanDocumentSource
      /**
       * Asks the shelf which documents the dropped names continue
       * (ADR-0097). Without it nothing is offered.
       */
      fassungOffers?: FassungOfferSource
      /**
       * The path of the folder the reader stands in, from the shelf root, or
       * null at the root: files are screened against where they land too.
       */
      screeningBasePath?: string | null
    },
    sendDirect: (files: File[]) => void
  ) => Promise<void>
  /**
   * The reader's answer for one file the upload screening excluded (ADR-0086):
   * upload it anyway, or not. Re-plans at once, because a released file can
   * create a folder and claim a name the excluded one did not, and then asks
   * the name probe about it, which it was kept out of until now. Rejects when
   * that probe fails; the file is held back again.
   */
  setReleased: (file: File, released: boolean) => Promise<void>
  /**
   * The plan as it stands when the reader confirms: every release probe still
   * in flight answered (or rolled back), the office's policy read afresh, and
   * the plan rebuilt with both. A file the fresh policy lets through that the
   * probe was never asked about is asked now. Rejects with
   * `UploadScreeningPolicyUnavailableError` when the policy cannot be read,
   * and with the probe's error when it cannot answer; null when a newer drop
   * replaced this one meanwhile.
   */
  settle: () => Promise<SettledPlan | null>
  /**
   * The reader's answer to „Als neue Fassung von X ablegen" for one file or
   * for all of a group at once: ticked or not, and which candidate. Picking a
   * candidate ticks the row unless said otherwise. Re-plans at once; the answer
   * is part of the plan the reader confirms.
   */
  changeFassung: (change: FassungChange) => void
  plan: FolderUploadPlan | null
  kind: UploadDecisionKind
  open: boolean
  setOpen: (open: boolean) => void
  pending: boolean
  setPending: (pending: boolean) => void
}

/**
 * One answer to "a document of this name is already here", for every durable
 * shelf.
 *
 * A same-name upload replaces the live document with a new version (ADR-0054),
 * and whether it asked first used to depend on what THIS browser remembered:
 * a tab that had uploaded to the project before refused the file as „bereits
 * hinzugefügt", a fresh one replaced the document without a word. The shelf
 * itself is the one fact both browsers share, so the decision is made from it
 * — asked of the server by name (`name-probe-client.ts`), because the listing
 * on screen is paged, filtered and leaves archived documents out, and a match
 * it did not carry used to be versioned without a word.
 *
 * Files that match nothing go out at once; anything that would touch an
 * existing document opens the plan dialog first, and so does a file whose name
 * continues one as its next Fassung (ADR-0097, `fassungOffers`). A folder always
 * opens it.
 */
export function useUploadDecision(): UploadDecision {
  const [plan, setPlan] = useState<FolderUploadPlan | null>(null)
  const [kind, setKind] = useState<UploadDecisionKind>('files')
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState(false)
  /**
   * The plan's own generation, so a second drop while the first is still being
   * hashed cannot land on top of it. Hashing a folder of models is seconds
   * long, which is ample time to drop another.
   */
  const generation = useRef(0)
  /** The last plan's input, digests included, so a release re-plans without re-reading anything. */
  const lastInput = useRef<FolderUploadPlanInput | null>(null)
  /** Where the last plan's documents came from, and the names the probe was already asked. */
  const lastSource = useRef<PlanDocumentSource>([])
  const lastOfferSource = useRef<FassungOfferSource | undefined>(undefined)
  const probed = useRef<Set<string>>(new Set())
  /** Release probes not yet answered: a confirm waits for them, or a file goes out as `new` that is a version. */
  const asking = useRef<Set<Promise<void>>>(new Set())

  const propose = useCallback<UploadDecision['propose']>(async (dropped, sendDirect) => {
    // What the operating system left in the folder is not part of the upload.
    const input = { ...dropped, files: dropped.files.filter((file) => !isSystemFile(file.name)) }
    if (input.files.length === 0) return
    const current = ++generation.current
    const isFolder = isFolderUpload(input.files)
    const { screeningBasePath, documents: source, fassungOffers: offerSource, ...planInput } = input
    // The screening first, and alone: the name probe is a request, and a name
    // the office's policy holds back must not leave the browser in it either
    // (ADR-0086). Without the policy nothing is planned and nothing is sent.
    const policy = await loadUploadScreeningPolicy()
    if (current !== generation.current) return
    const screening = { policy, basePath: screeningBasePath ?? null, released: new Set<File>() }
    const screened = buildFolderUploadPlan({ ...planInput, documents: [], screening })
    const admitted = screened.files.filter((file) => file.action !== 'excluded').map((file) => file.file)
    const [documents, offers] = await Promise.all([documentsFor(source, admitted), offersFor(offerSource, admitted)])
    if (current !== generation.current) return
    lastSource.current = source
    lastOfferSource.current = offerSource
    probed.current = new Set(admitted.map((file) => file.name))
    asking.current = new Set()
    const base = withOffers({ ...planInput, documents, screening }, offers)
    // First pass names the plausible duplicates; only those are read into
    // memory. Everything else is an upload either way. An excluded file is not
    // `new`, so the reader is always shown what the screening held back.
    const first = buildFolderUploadPlan(base)
    if (!isFolder && !needsUploadDecision(first)) {
      lastInput.current = null
      sendDirect([...input.files])
      return
    }
    setKind(isFolder ? 'folder' : 'files')
    setPlan(null)
    setPending(false)
    setOpen(true)
    const digests = await digestFiles(first.hashCandidates)
    if (current !== generation.current) return
    lastInput.current = { ...base, digests }
    setPlan(buildFolderUploadPlan(lastInput.current))
  }, [])

  /**
   * Ask the name probe about the files it was never asked about, and fold what
   * it finds, and the digests that makes worth reading, into the input as it is
   * when the answer lands. Into THAT input, not the one this call started
   * from: two releases answered out of order each keep the other's documents.
   */
  const probe = useCallback(async (files: readonly File[], current: number): Promise<void> => {
    const unasked = files.filter((file) => !probed.current.has(file.name))
    if (unasked.length === 0) return
    const [found, offers] = await Promise.all([
      documentsFor(lastSource.current, unasked),
      offersFor(lastOfferSource.current, unasked),
    ])
    if (current !== generation.current || !lastInput.current) return
    // Kept the moment it is known, before the read below: the name is not asked
    // again, so an answer dropped with a failed read would plan a version as new.
    for (const file of unasked) probed.current.add(file.name)
    lastInput.current = withOffers(withDocuments(lastInput.current, found), offers)
    setPlan(buildFolderUploadPlan(lastInput.current))
    const asked = lastInput.current
    const unread = buildFolderUploadPlan(asked).hashCandidates.filter((candidate) => !asked.digests?.has(candidate))
    const read = await digestFiles(unread)
    if (current !== generation.current || !lastInput.current) return
    const latest = lastInput.current
    lastInput.current = { ...latest, digests: new Map([...(latest.digests ?? []), ...read]) }
    setPlan(buildFolderUploadPlan(lastInput.current))
  }, [])

  const setReleased = useCallback<UploadDecision['setReleased']>(
    async (file, released) => {
      const input = lastInput.current
      if (!input?.screening) return
      const next = new Set(input.screening.released)
      if (released) next.add(file)
      else next.delete(file)
      lastInput.current = { ...input, screening: { ...input.screening, released: next } }
      setPlan(buildFolderUploadPlan(lastInput.current))
      // The released file was kept out of the name probe. Now that the reader
      // has let it go, ask whether the shelf already holds its name, so it is
      // planned as the version it would be rather than as new.
      if (!released || probed.current.has(file.name)) return
      const current = generation.current
      const answer = probe([file], current).catch((error: unknown) => {
        const latest = lastInput.current
        if (current === generation.current && latest?.screening) {
          // Unknown whether it would replace a document: it is held back again.
          const kept = new Set(latest.screening.released)
          kept.delete(file)
          lastInput.current = { ...latest, screening: { ...latest.screening, released: kept } }
          setPlan(buildFolderUploadPlan(lastInput.current))
        }
        throw error
      })
      // Tracked until it settles, rollback included, so a confirm waits for both.
      const tracked = answer.then(
        () => undefined,
        () => undefined
      )
      asking.current.add(tracked)
      void tracked.then(() => asking.current.delete(tracked))
      await answer
    },
    [probe]
  )

  const changeFassung = useCallback<UploadDecision['changeFassung']>(({ files, chosen, targetId }) => {
    const input = lastInput.current
    if (!input) return
    const choices = new Map(input.fassungChoices ?? [])
    for (const file of files) {
      choices.set(file, { ...choices.get(file), ...(targetId ? { targetId, chosen: chosen ?? true } : { chosen }) })
    }
    lastInput.current = { ...input, fassungChoices: choices }
    setPlan(buildFolderUploadPlan(lastInput.current))
  }, [])

  const settle = useCallback<UploadDecision['settle']>(async () => {
    const current = generation.current
    while (asking.current.size > 0) await Promise.all([...asking.current])
    // Read afresh: an admin may have saved a term while the dialog was open,
    // and the folders this plan creates are named before any file is screened.
    const policy = await loadUploadScreeningPolicy()
    const input = lastInput.current
    if (current !== generation.current || !input?.screening) return null
    lastInput.current = { ...input, screening: { ...input.screening, policy } }
    const admitted = buildFolderUploadPlan(lastInput.current)
      .files.filter((file) => file.action !== 'excluded')
      .map((file) => file.file)
    await probe(admitted, current)
    if (current !== generation.current || !lastInput.current) return null
    const settled = buildFolderUploadPlan(lastInput.current)
    setPlan(settled)
    return { plan: settled, policy }
  }, [probe])

  return { propose, setReleased, settle, changeFassung, plan, kind, open, setOpen, pending, setPending }
}
