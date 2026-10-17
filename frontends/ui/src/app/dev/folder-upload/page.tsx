'use client'

/**
 * Dev preview for the folder-upload plan — the dialog a dropped directory tree
 * opens before anything moves. 404s outside development.
 *
 * The default fixture is the case the feature exists for: a büro re-syncing an
 * Einreichung a fortnight later. Most of it is unchanged and is skipped, a
 * handful of drawings have been corrected and are offered as an update, two
 * files are new, and the folders it needs were all matched to folders that
 * already exist rather than created beside them. What the shot has to prove is
 * that the four counts read as one sentence, and that the checkbox is visibly
 * the only decision on the surface.
 *
 * `?variant=first` is the OTHER half of the story: the first time this project
 * sees the folder. Nothing matches, every folder is created, and there is no
 * update question to ask — so the checkbox is absent rather than present and
 * unticked, which is the difference between "nothing to decide" and "decided
 * for you".
 *
 * `?variant=collisions` is the state that used to lose work silently. Two files
 * in one drop share a filename; a project holds one document per name
 * (migration 0074), so before the plan existed both uploaded and one overwrote
 * the other with nothing said. Neither is sent now, the pair is named, and the
 * upload button is disabled because the reader has something to fix first.
 *
 * `?variant=known` is the half the plan used to get wrong: the same folder,
 * against a corpus somebody has since worked on. One document was renamed here,
 * so the plan names it — approving a replacement you cannot find in your own
 * file list is not approval. One file matches a document under a name the
 * SERVER would not treat as the same (case), so it is reported as already here
 * rather than uploaded into a second copy. And one unchanged document has been
 * re-filed in Piloti, so it is moved rather than left where it is under a
 * dialog that promises to reproduce the tree.
 *
 * `?variant=fassungen` is an ArchiCAD publisher export of the same project: the
 * files continue documents already on the shelf (ADR-0099). The clear matches
 * are ONE list under a sticky master box, ticked and grouped by folder; the ones
 * that need the reader (two current documents, or not newer than the one there)
 * sit apart and unticked with the documents to choose from. The boxes work, so
 * the shot can show the master half-filled and the confirm label moving.
 * `?variant=fassungen-40` is the same at the size it arrives in: forty rows in
 * four folders, two same-name updates in the same block (one concept, ADR-0099),
 * long names whose index and date must survive the cut.
 *
 * `?variant=single-fassung`, `single-unclear` and `single-older` are ONE loose
 * file that continues a document under another name: a clear match, a file that
 * could continue two documents, and one that is not newer than the document it
 * would continue. Each is the light layout with two named outcomes.
 *
 * `?variant=planning` is the seconds a large folder spends being read and
 * hashed before any of the above can be shown. It is a real state on a
 * 500-file drop and it says what it is doing, rather than leaving a bare
 * spinner over an empty dialog.
 */

import type { JSX } from 'react'
import { useMemo, useState } from 'react'
import { notFound, useSearchParams } from 'next/navigation'
import { FolderUploadDialog } from '@/features/documents/components/folder-upload-dialog'
import {
  buildFolderUploadPlan,
  type FassungChoice,
  type FolderUploadPlan,
} from '@/features/documents/lib/folder-upload-plan'
import type { FassungChange } from '@/features/documents/lib/fassung-proposals'
import type { FassungCandidateMatch } from '@/lib/documents/name-probe-types'
import type { FileItem, FolderItem } from '@/features/documents/components/project-file-workspace'

/** A `File` carrying the path a folder input would report. */
function pathed(relativePath: string, size: number): File {
  const name = relativePath.split('/').pop()!
  const file = new File(['x'], name, { type: 'application/pdf' })
  Object.defineProperty(file, 'webkitRelativePath', { value: relativePath, configurable: true })
  Object.defineProperty(file, 'size', { value: size, configurable: true })
  return file
}

function doc(filename: string, extra: Partial<FileItem> = {}): FileItem {
  return {
    id: `doc-${filename}`,
    filename,
    displayName: null,
    fileSize: 1_000,
    contentType: 'application/pdf',
    status: 'ready',
    folderId: null,
    originPath: null,
    contentHash: null,
    createdAt: '2026-08-20T09:00:00Z',
    errorMessage: null,
    summary: null,
    pageCount: null,
    chunkCount: null,
    contentTypes: null,
    tags: null,
    topics: null,
    capture: null,
    assignees: [],
    authoredBy: 'user',
    ...extra,
  }
}

const IDENTICAL = `sha256:${'a'.repeat(64)}`

const FOLDERS: FolderItem[] = [
  { id: 'f-root', parentId: null, name: 'Wohnbau Nord', path: 'Wohnbau Nord' },
  { id: 'f-plaene', parentId: 'f-root', name: 'Pläne', path: 'Wohnbau Nord/Pläne' },
  { id: 'f-statik', parentId: 'f-root', name: 'Statik', path: 'Wohnbau Nord/Statik' },
]

/** The re-sync: mostly unchanged, a few corrections, two genuinely new files. */
function resyncPlan(): FolderUploadPlan {
  const unchanged = [
    pathed('Wohnbau Nord/Pläne/EG.pdf', 1_000),
    pathed('Wohnbau Nord/Pläne/OG.pdf', 1_000),
    pathed('Wohnbau Nord/Statik/Bewehrung.pdf', 1_000),
  ]
  const corrected = [
    pathed('Wohnbau Nord/Pläne/Schnitt_A.pdf', 2_400),
    pathed('Wohnbau Nord/Statik/Nachweis.pdf', 2_400),
  ]
  const fresh = [
    pathed('Wohnbau Nord/Pläne/Detail_Attika.pdf', 900),
    pathed('Wohnbau Nord/Brandschutz/Konzept.pdf', 900),
  ]

  return buildFolderUploadPlan({
    files: [...unchanged, ...corrected, ...fresh],
    folders: FOLDERS,
    currentFolderId: null,
    documents: [
      // Filed where the first sync put them, which is where this one puts them
      // too — a re-sync does not move anything it does not have to.
      doc('EG.pdf', { fileSize: 1_000, contentHash: IDENTICAL, folderId: 'f-plaene' }),
      doc('OG.pdf', { fileSize: 1_000, contentHash: IDENTICAL, folderId: 'f-plaene' }),
      doc('Bewehrung.pdf', { fileSize: 1_000, contentHash: IDENTICAL, folderId: 'f-statik' }),
      // Same name, same size, different bytes — the case only a digest can tell
      // apart, and the reason the column exists.
      doc('Schnitt_A.pdf', { fileSize: 2_400, contentHash: IDENTICAL, folderId: 'f-plaene' }),
      // Somebody re-filed this one in Piloti after the first sync. The tree
      // puts it back, and the dialog says so before it moves.
      doc('Nachweis.pdf', { fileSize: 2_400, contentHash: IDENTICAL, folderId: null }),
    ],
    digests: new Map([
      ...unchanged.map((file) => [file, IDENTICAL] as const),
      ...corrected.map((file) => [file, `sha256:${'b'.repeat(64)}`] as const),
    ]),
  })
}

/** The first sync: nothing here yet, so every folder is a creation. */
function firstPlan(): FolderUploadPlan {
  return buildFolderUploadPlan({
    files: [
      pathed('Wohnbau Nord/Pläne/EG.pdf', 1_000),
      pathed('Wohnbau Nord/Pläne/OG.pdf', 1_000),
      pathed('Wohnbau Nord/Statik/Nachweis.pdf', 1_000),
    ],
    documents: [],
    folders: [],
    currentFolderId: null,
  })
}

/** Two files, one name — the loss the plan reports instead of committing. */
function collisionPlan(): FolderUploadPlan {
  return buildFolderUploadPlan({
    files: [
      pathed('Wohnbau Nord/Pläne/Deckblatt.pdf', 1_000),
      pathed('Wohnbau Nord/Statik/Deckblatt.pdf', 1_200),
      pathed('Wohnbau Nord/Pläne/EG.pdf', 1_000),
    ],
    documents: [],
    folders: FOLDERS,
    currentFolderId: null,
  })
}

/**
 * The corpus somebody has worked on since the last sync: a rename, a re-filing,
 * and a file whose name matches a document only in the loose sense.
 */
function knownPlan(): FolderUploadPlan {
  const unchanged = pathed('Wohnbau Nord/Pläne/EG.pdf', 1_000)
  const renamed = pathed('Wohnbau Nord/Statik/Nachweis.pdf', 2_400)
  const otherCase = pathed('Wohnbau Nord/Pläne/DECKBLATT.pdf', 900)

  return buildFolderUploadPlan({
    files: [unchanged, renamed, otherCase],
    folders: FOLDERS,
    currentFolderId: null,
    documents: [
      // Byte-identical, and filed at the root since the last sync. Nothing to
      // upload, and still something to do.
      doc('EG.pdf', { fileSize: 1_000, contentHash: IDENTICAL, folderId: null }),
      // Renamed here. The drop still says `Nachweis.pdf`; the file list says
      // something else, and the dialog has to bridge the two.
      doc('Nachweis.pdf', {
        fileSize: 2_400,
        contentHash: IDENTICAL,
        folderId: 'f-statik',
        displayName: 'Statischer Nachweis — Freigabe 08/26',
      }),
      // Same document to a person, a second row to Postgres.
      doc('Deckblatt.pdf', { fileSize: 900, folderId: 'f-plaene' }),
    ],
    digests: new Map([
      [unchanged, IDENTICAL],
      [renamed, `sha256:${'b'.repeat(64)}`],
    ]),
  })
}

/** What the Fassung probe answered for the export's files, built from the dropped names. */
function exportOffers(files: readonly File[]): Map<string, FassungCandidateMatch> {
  const one = (name: string, held: string, label: string): FassungCandidateMatch => ({
    name,
    candidates: [{ id: `doc-${held}`, filename: held, displayName: null, label }],
    newer: true,
    unambiguous: true,
  })
  const offers = new Map<string, FassungCandidateMatch>()
  for (const file of files) {
    const sheet = /Blatt_(\d+)_Index_C/.exec(file.name)
    if (sheet) offers.set(file.name, one(file.name, `Blatt_${sheet[1]}_Index_B.pdf`, 'Index B · 02.07.2026'))
  }
  offers.set('Detail_Stiege_Index_C.pdf', {
    name: 'Detail_Stiege_Index_C.pdf',
    candidates: [
      { id: 'doc-stiege-b', filename: 'Detail_Stiege_Index_B.pdf', displayName: null, label: 'Index B' },
      { id: 'doc-stiege-a', filename: 'Detail_Stiege_Index_A.pdf', displayName: null, label: 'Index A' },
    ],
    newer: true,
    unambiguous: false,
  })
  offers.set('Schnitt_BB_Index_A.pdf', {
    name: 'Schnitt_BB_Index_A.pdf',
    candidates: [{ id: 'doc-bb-c', filename: 'Schnitt_BB_Index_C.pdf', displayName: null, label: 'Index C' }],
    newer: false,
    unambiguous: false,
  })
  return offers
}

/** A drop with offers, and the documents and digests it is planned against. */
interface OfferedDrop {
  files: File[]
  offers: Map<string, FassungCandidateMatch>
  documents?: FileItem[]
  digests?: Map<File, string>
}

/** The publisher export: twelve sheets, two that need the reader. */
function exportDrop(): OfferedDrop {
  const files = [
    ...Array.from({ length: 12 }, (_, i) =>
      pathed(`Export/${i % 3 === 0 ? 'Schnitte' : 'Grundrisse'}/Blatt_${String(i).padStart(2, '0')}_Index_C.pdf`, 1_000 + i)
    ),
    pathed('Export/Details/Detail_Stiege_Index_C.pdf', 900),
    pathed('Export/Schnitte/Schnitt_BB_Index_A.pdf', 900),
  ]
  return { files, offers: exportOffers(files) }
}

/** Forty files of an Einreichung, the size a publisher export arrives in. */
function fortyDrop(): OfferedDrop {
  const root = 'Einreichung_2026-10'
  const folders = [
    ['01_Grundrisse', 'Grundriss_Erdgeschoss', 12],
    ['02_Schnitte', 'Schnitt_Laengsschnitt', 10],
    ['03_Ansichten', 'Ansicht_Nordfassade', 8],
    ['04_Details', 'Detail_Fensteranschluss', 4],
  ] as const
  const offers = new Map<string, FassungCandidateMatch>()
  const sheets = folders.flatMap(([folder, title, count], f) =>
    Array.from({ length: count }, (_, i) => {
      const sheet = `${['EG', 'SN', 'AN', 'DT'][f]}-${100 + i * 4}_${title}`
      const name = `${sheet}_Index_C_2026-10-02.pdf`
      const held = `${sheet}_Index_B_2026-07-02.pdf`
      offers.set(name, {
        name,
        candidates: [{ id: `doc-${held}`, filename: held, displayName: null, label: 'Index B · 02.07.2026' }],
        newer: true,
        unambiguous: true,
      })
      return pathed(`${root}/${folder}/${name}`, 2_000 + i)
    })
  )
  const unclear = [
    pathed(`${root}/04_Details/Detail_Attika_Index_C.pdf`, 900),
    pathed(`${root}/04_Details/Detail_Stiege_Index_C.pdf`, 900),
    pathed(`${root}/02_Schnitte/Schnitt_BB_Index_A.pdf`, 900),
  ]
  offers.set('Detail_Attika_Index_C.pdf', {
    name: 'Detail_Attika_Index_C.pdf',
    candidates: [
      { id: 'doc-attika-b', filename: 'Detail_Attika_Index_B.pdf', displayName: 'Attika, Detail 1:10 (Freigabe)', label: 'Index B · 12.08.2026' },
      { id: 'doc-attika-b2', filename: 'Detail_Attika_Index_B2.pdf', displayName: null, label: 'Index B' },
    ],
    newer: true,
    unambiguous: false,
  })
  for (const [name, offer] of exportOffers(unclear)) offers.set(name, offer)
  // Same name as a document here, different bytes: a new Fassung too, in the same block.
  const sameName = [pathed(`${root}/Baubeschreibung.pdf`, 3_000), pathed(`${root}/Deckblatt.pdf`, 3_000)]
  return {
    files: [...sheets, ...unclear, ...sameName, pathed(`${root}/Lageplan_Notiz.pdf`, 500)],
    offers,
    documents: [
      doc('Baubeschreibung.pdf', { fileSize: 3_000, contentHash: IDENTICAL }),
      doc('Deckblatt.pdf', { fileSize: 3_000, contentHash: IDENTICAL }),
    ],
    digests: new Map(sameName.map((file) => [file, `sha256:${'b'.repeat(64)}`] as const)),
  }
}

/** One loose file that continues a document: clear, between two documents, or older than the one there. */
function soleDrop(variant: 'single-fassung' | 'single-unclear' | 'single-older'): OfferedDrop {
  const name =
    variant === 'single-older' ? 'EG_Grundriss_Index_A_2026-05-02.pdf' : 'EG_Grundriss_Index_C_2026-10-02.pdf'
  const candidates =
    variant === 'single-unclear'
      ? [
          { id: 'doc-eg-b', filename: 'EG_Grundriss_Index_B_2026-07-02.pdf', displayName: null, label: 'Index B · 02.07.2026' },
          { id: 'doc-eg-b-alt', filename: 'EG_Grundriss_Variante_Index_B.pdf', displayName: 'Grundriss EG, Variante', label: 'Index B' },
        ]
      : [{ id: 'doc-eg-b', filename: 'EG_Grundriss_Index_B_2026-07-02.pdf', displayName: null, label: 'Index B · 02.07.2026' }]
  return {
    files: [pathed(name, 1_000)],
    offers: new Map([
      [name, { name, candidates, newer: variant !== 'single-older', unambiguous: variant === 'single-fassung' }],
    ]),
  }
}

/** A drop with offers and working boxes: the answers re-plan, as `useUploadDecision` does. */
function OfferedPreview({ drop, kind }: { drop: () => OfferedDrop; kind: 'folder' | 'files' }): JSX.Element {
  // Built once per mount (the variant is the key): the answers are kept by File, so the files must stay the same objects.
  const [built] = useState(drop)
  const [choices, setChoices] = useState<Map<File, FassungChoice>>(new Map())
  const [confirmed, setConfirmed] = useState<string | null>(null)
  const plan = useMemo(
    () =>
      buildFolderUploadPlan({
        files: built.files,
        folders: [],
        currentFolderId: null,
        documents: built.documents ?? [],
        digests: built.digests,
        fassungOffers: built.offers,
        fassungChoices: choices,
      }),
    [built, choices]
  )
  const change = ({ files: changed, chosen, targetId }: FassungChange) =>
    setChoices((previous) => {
      const next = new Map(previous)
      for (const file of changed) next.set(file, { ...next.get(file), ...(targetId ? { targetId, chosen: chosen ?? true } : { chosen }) })
      return next
    })
  // What the confirm would send, so the preview shows the answer reached the plan.
  const confirm = () =>
    setConfirmed(
      plan.files.map((file) => `${file.file.name} → ${file.fassungOf?.chosen ? file.fassungOf.of.name : 'eigenes Dokument'}`).join('\n')
    )
  return (
    <>
      <FolderUploadDialog
        open={confirmed === null}
        onOpenChange={() => {}}
        plan={plan}
        currentFolderName={null}
        onConfirm={confirm}
        onFassungChange={change}
        kind={kind}
      />
      {confirmed && (
        <pre className="mx-auto max-w-lg whitespace-pre-wrap font-mono text-xs" data-testid="folder-upload-preview-confirmed">
          {confirmed}
        </pre>
      )}
    </>
  )
}

export default function FolderUploadPreviewPage(): JSX.Element {
  if (process.env.NODE_ENV !== 'development') {
    notFound()
  }
  const variant = useSearchParams()?.get('variant') ?? 'resync'
  const plan =
    variant === 'planning'
      ? null
      : variant === 'first'
        ? firstPlan()
        : variant === 'collisions'
          ? collisionPlan()
          : variant === 'known'
            ? knownPlan()
            : resyncPlan()

  return (
    <main className="min-h-dvh bg-background px-4 py-10" data-testid="folder-upload-preview">
      <h1 className="mx-auto mb-6 max-w-lg font-mono text-xs text-muted-foreground">
        /dev/folder-upload — {variant}
      </h1>
      {variant === 'fassungen' ? (
        <OfferedPreview drop={exportDrop} kind="folder" />
      ) : variant === 'fassungen-40' ? (
        <OfferedPreview drop={fortyDrop} kind="folder" />
      ) : variant === 'single-fassung' || variant === 'single-unclear' || variant === 'single-older' ? (
        <OfferedPreview key={variant} drop={() => soleDrop(variant)} kind="files" />
      ) : (
        <FolderUploadDialog
          open
          onOpenChange={() => {}}
          plan={plan}
          currentFolderName={null}
          onConfirm={() => {}}
        />
      )}
    </main>
  )
}
