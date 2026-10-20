'use client'

/**
 * Dev preview: Piloti files the uploads into described folders, and proposes
 * it rather than doing it (`docs/ux/file-upload-and-explorer.md`, „Folders
 * that say what they hold, and Piloti's filing suggestion").
 *
 *   1. A mixed grid: cards with a filing chip in the footer beside cards
 *      without one, all one height, under the filing bar (one target folder
 *      collects two files).
 *   2. A chip's popover open, for a folder that exists: the move as a before
 *      and an after, the reason, „Alle 2 verschieben", the other file lit.
 *   3. The same for a folder the move creates: „neu", „Anlegen und verschieben".
 *   4. A bar line under the pointer, and the cards it would move outlined.
 *   5. A reader who may not decide: the path and the reason, no buttons.
 *   6. The list view: the chip right after the name, rows of one height.
 *   7. The upload tray: the bar for its batch, the chip on its rows.
 *   8. A folder's description at the top of the folder, in its three states,
 *      and the dialog it is written in.
 *
 * Nothing leaves the browser: the faked proposals API (`_fixtures`) answers
 * `/api/proposals/{id}` and its apply and dismiss, so the buttons can be
 * pressed. Not linked from anywhere; the `/dev` layout 404s it outside
 * development.
 */

import { useEffect, useRef, useState, type JSX, type ReactNode } from 'react'
import { FileListView } from '@/features/documents/components/file-list-view'
import { FileCard } from '@/features/documents/components/file-card'
import { FileGrid } from '@/features/documents/components/file-grid'
import { FilingViewBar } from '@/features/documents/components/filing-bar'
import { FilingSuggestionsProvider } from '@/features/documents/components/filing-suggestion'
import { FolderDescriptionDialog, FolderDescriptionLine } from '@/features/documents/components/folder-description-dialog'
import { UploadTray } from '@/features/documents/components/upload-tray'
import type { FileItem, FolderItem } from '@/features/documents/file-types'
import { suggestionsByDocument, suggestionsByFolder } from '@/features/documents/lib/filing-suggestions'
import type { TrackedFile } from '@/features/documents/types'
import type { ListedProposal, ProposedChangeView } from '@/lib/proposals/types'
import { useFakeProposalClient } from '../_fixtures/fake-proposals'

type FileProposal = Extract<ProposedChangeView, { kind: 'file_operation' }>

const MB = 1_000_000

const proposal = (id: string, patch: Partial<FileProposal>): FileProposal => ({
  id,
  projectId: 'p1',
  status: 'proposed',
  proposedByKind: 'piloti',
  onBehalfOf: 'user_me',
  onBehalfOfName: 'Mia Huber',
  originConversationId: null,
  originMessageId: null,
  createdAt: '2026-10-14T08:00:00.000Z',
  decidedBy: null,
  decidedByName: null,
  decidedAt: null,
  results: null,
  canDecide: true,
  kind: 'file_operation',
  payload: { operation: 'move', operations: [], basis: 'name' },
  ...patch,
})

const PERMIT_DECISIONS = proposal('00000000-0000-4000-8000-0000000000f1', {
  payload: {
    operation: 'move',
    operations: [
      {
        document: 'MA37_Baubewilligung_2026-09.pdf',
        source: 'project',
        target_folder: 'Behörde/Bescheide',
        reason: 'Ein Bescheid der MA 37; „Bescheide“ hält laut Beschreibung Bescheide und Stellungnahmen.',
      },
      {
        document: 'Stellungnahme_MA22.pdf',
        source: 'project',
        target_folder: 'Behörde/Bescheide',
        reason: 'Eine Stellungnahme der MA 22 zum Bauverfahren.',
      },
    ],
    basis: 'name',
  },
})

const CORRESPONDENCE = proposal('00000000-0000-4000-8000-0000000000f2', {
  payload: {
    operation: 'move',
    operations: [
      {
        document: 'Schreiben_Fristerstreckung.pdf',
        source: 'project',
        target_folder: 'Korrespondenz',
        reason: 'Ein Brief an die Behörde. Das Büro legt Briefe in vier Projekten unter „Korrespondenz“ ab.',
      },
    ],
    basis: 'content',
    new_folder: { path: 'Korrespondenz', description: 'Briefe und Mails mit Behörden und Bauherrschaft' },
  },
})

const LISTED: ListedProposal[] = [
  {
    proposal: PERMIT_DECISIONS,
    documents: [
      { id: 'doc-bescheid', name: 'MA37_Baubewilligung_2026-09.pdf' },
      { id: 'doc-stellungnahme', name: 'Stellungnahme_MA22.pdf' },
    ],
  },
  { proposal: CORRESPONDENCE, documents: [{ id: 'doc-brief', name: 'Schreiben_Fristerstreckung.pdf' }] },
]

/** The same suggestions, held under ids of their own, for a reader the server says may not decide. */
const READ_ONLY: ListedProposal[] = LISTED.map((entry, index) => ({
  ...entry,
  proposal: { ...entry.proposal, id: `00000000-0000-4000-8000-0000000000e${index}`, canDecide: false },
}))

/** Every proposal the faked API answers; a stable array, as `useFakeProposalClient` asks. */
const ANSWERED = [...LISTED, ...READ_ONLY]

const SHELF = { byDocument: suggestionsByDocument(LISTED), byFolder: suggestionsByFolder(LISTED) }
const SHELF_READ_ONLY = { byDocument: suggestionsByDocument(READ_ONLY), byFolder: suggestionsByFolder(READ_ONLY) }

/** Where each document is now: the decision and the statement in an inbox folder, the rest at the top level. */
const LOCATION: Record<string, string> = { 'doc-bescheid': 'Eingang', 'doc-stellungnahme': 'Eingang' }
const folderPathOf = (documentId: string): string => LOCATION[documentId] ?? ''

const tracked = (id: string, fileName: string, serverFileId: string, fileSize: number): TrackedFile => ({
  id,
  fileName,
  fileSize,
  status: 'ingesting',
  progress: 0,
  collectionName: 'proj-1',
  serverFileId,
})

const TRAY: TrackedFile[] = [
  tracked('t1', 'MA37_Baubewilligung_2026-09.pdf', 'doc-bescheid', 1.4 * MB),
  tracked('t2', 'Stellungnahme_MA22.pdf', 'doc-stellungnahme', 0.6 * MB),
  tracked('t3', 'Schreiben_Fristerstreckung.pdf', 'doc-brief', 0.3 * MB),
  tracked('t4', 'Einreichplan_EG.pdf', 'doc-eg', 3.2 * MB),
]

const doc = (id: string, filename: string, summary: string | null, fileSize = 1.2 * MB): FileItem => ({
  id,
  filename,
  displayName: null,
  fileSize,
  contentType: 'application/pdf',
  status: 'completed',
  folderId: null,
  createdAt: '2026-10-14T08:00:00Z',
  errorMessage: null,
  summary,
  pageCount: 4,
  chunkCount: 8,
  contentTypes: ['text'],
  tags: null,
  topics: null,
  capture: null,
})

const GROUND_FLOOR_PLAN = doc('doc-eg', 'Einreichplan_EG.pdf', 'Grundriss Erdgeschoß, Einreichung.')
const PERMIT_DECISION = doc('doc-bescheid', 'MA37_Baubewilligung_2026-09.pdf', 'Baubewilligung für den Zubau, mit Auflagen zum Brandschutz.')
const BRIEF = doc('doc-brief', 'Schreiben_Fristerstreckung.pdf', 'Ansuchen um Erstreckung der Frist für die Nachreichung.')
const STATEMENT = doc('doc-stellungnahme', 'Stellungnahme_MA22.pdf', 'Stellungnahme der Umweltschutzabteilung.', 0.6 * MB)
const LISTING: FileItem[] = [GROUND_FLOOR_PLAN, PERMIT_DECISION, BRIEF, STATEMENT]
const LISTING_IDS = LISTING.map((file) => file.id)

const DESCRIBED: FolderItem = {
  id: 'f-bescheide',
  parentId: null,
  name: 'Bescheide',
  path: 'Behörde/Bescheide',
  description: 'Bescheide und Stellungnahmen der Baubehörde und der Amtssachverständigen.',
}
const UNDESCRIBED: FolderItem = { id: 'f-fotos', parentId: null, name: 'Fotos', path: 'Fotos', description: null }

const noop = () => undefined

function Stage({ title, note, children }: { title: string; note: string; children: ReactNode }): JSX.Element {
  return (
    <section className="space-y-2">
      <div>
        <h2 className="text-foreground text-sm font-semibold">{title}</h2>
        <p className="text-muted-foreground text-xs">{note}</p>
      </div>
      <div className="bg-background overflow-hidden rounded-xl border">{children}</div>
    </section>
  )
}

/** One state of a component, named, so a row of look-alikes reads as the states they are. */
function State({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  return (
    <div className="space-y-1.5 p-4">
      <p className="text-muted-foreground text-[11px] font-medium uppercase tracking-wider">{label}</p>
      {children}
    </div>
  )
}

/** A shelf's suggestions around a stage, as the Files workspace provides them. */
function Shelf({
  readOnly = false,
  open = null,
  children,
}: {
  readOnly?: boolean
  /** The document whose chip's popover is open on arrival. */
  open?: string | null
  children: ReactNode
}): JSX.Element {
  const shelf = readOnly ? SHELF_READ_ONLY : SHELF
  return (
    <FilingSuggestionsProvider
      byDocument={shelf.byDocument}
      byFolder={shelf.byFolder}
      onSettled={noop}
      folderPathOf={folderPathOf}
      openOnArrival={open}
    >
      {children}
    </FilingSuggestionsProvider>
  )
}

const card = (file: FileItem) => <FileCard key={file.id} file={file} isSelected={false} onSelect={noop} locale="de" />

/** The first line of the bar under the pointer, as if hovered: what the reader sees while deciding there. */
function HoveredFirstLine({ children }: { children: ReactNode }): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const line = ref.current?.querySelector('[data-testid="filing-bar-line"]')
    line?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: null }))
  }, [])
  return <div ref={ref}>{children}</div>
}

export default function FilingSuggestionsDevPage(): JSX.Element {
  const [writing, setWriting] = useState<FolderItem | null>(null)
  const ready = useFakeProposalClient(ANSWERED)

  return (
    <main className="mx-auto flex max-w-5xl flex-col gap-8 p-4 sm:p-6">
      <div>
        <h1 className="text-lg font-semibold">Ablagevorschläge</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Piloti schlägt vor, in welchen beschriebenen Ordner ein Upload gehört. Eine Person bestätigt pro Ordner.
        </p>
      </div>

      {ready && (
        <>
          <Stage
            title="1 · Raster: Karten mit und ohne Vorschlag"
            note="Der Chip sitzt links im Fuß, jede Karte bleibt gleich hoch. Die Leiste erscheint, weil „Behörde/Bescheide“ zwei Dateien sammelt."
          >
            <Shelf>
              <FilingViewBar documentIds={LISTING_IDS} className="px-4 pt-4" />
              <div className="p-4">
                <FileGrid>{LISTING.map(card)}</FileGrid>
              </div>
            </Shelf>
          </Stage>

          <Stage
            title="2 · Popover offen: bestehender Ordner"
            note="Der Weg vorher und nachher, der Grund, „Alle 2 verschieben“. Die zweite Datei, die mitwandert, ist umrandet."
          >
            <Shelf open={PERMIT_DECISION.id}>
              <div className="p-4">
                <FileGrid>{[GROUND_FLOOR_PLAN, PERMIT_DECISION, STATEMENT].map(card)}</FileGrid>
              </div>
            </Shelf>
          </Stage>

          <Stage
            title="3 · Popover offen: neuer Ordner"
            note="Liegt oben im Projektordner; der Ordner entsteht mit dem Verschieben."
          >
            <Shelf open={BRIEF.id}>
              <div className="p-4">
                <FileGrid>{[GROUND_FLOOR_PLAN, BRIEF].map(card)}</FileGrid>
              </div>
            </Shelf>
          </Stage>

          <Stage
            title="4 · Leiste: eine Zeile unter dem Zeiger"
            note="„Behörde/Bescheide“ ist gewählt; die zwei Karten, die sie verschieben würde, sind umrandet, ohne Füllung."
          >
            <Shelf>
              <HoveredFirstLine>
                <FilingViewBar documentIds={LISTING_IDS} className="px-4 pt-4" />
              </HoveredFirstLine>
              <div className="p-4">
                <FileGrid>{LISTING.map(card)}</FileGrid>
              </div>
            </Shelf>
          </Stage>

          <Stage title="5 · Wer nur lesen darf" note="Weg und Grund, und wer verschieben darf; keine Knöpfe, auch nicht in der Leiste.">
            <Shelf readOnly open={PERMIT_DECISION.id}>
              <FilingViewBar documentIds={LISTING_IDS} className="px-4 pt-4" />
              <div className="p-4">
                <FileGrid>{[GROUND_FLOOR_PLAN, PERMIT_DECISION, STATEMENT].map(card)}</FileGrid>
              </div>
            </Shelf>
          </Stage>

          <Stage
            title="6 · Liste"
            note="Derselbe Chip direkt nach dem Namen, mit demselben Popover. Die Zeilen behalten ihre Höhe."
          >
            <Shelf>
              <FilingViewBar documentIds={LISTING_IDS} className="px-4 pb-2 pt-4" />
              <FileListView files={LISTING} selectedFileId={null} onSelectFile={noop} />
            </Shelf>
          </Stage>

          <Stage
            title="7 · Im Upload, solange die Person da ist"
            note="Ablegen ist hier die Aufgabe: die Leiste steht für den ganzen Stapel, auch für eine Datei. Die Zeilen tragen den Chip."
          >
            <div className="bg-card">
              <Shelf>
                <UploadTray files={TRAY} onRetry={noop} onDismiss={noop} />
              </Shelf>
            </div>
          </Stage>
        </>
      )}

      <Stage
        title="8 · Was in einen Ordner gehört"
        note="Oben im Ordner: die Beschreibung, und für wer schreiben darf, der Weg sie zu ändern."
      >
        <div className="bg-card divide-y">
          <State label="Mit Beschreibung, für wer schreiben darf">
            <FolderDescriptionLine folder={DESCRIBED} canEdit onEdit={() => setWriting(DESCRIBED)} />
          </State>
          <State label="Ohne Beschreibung, für wer schreiben darf: nur die Einladung">
            <FolderDescriptionLine folder={UNDESCRIBED} canEdit onEdit={() => setWriting(UNDESCRIBED)} />
          </State>
          <State label="Mit Beschreibung, für wer nur lesen darf: kein Weg, sie zu ändern">
            <FolderDescriptionLine folder={DESCRIBED} canEdit={false} onEdit={noop} />
          </State>
        </div>
      </Stage>

      <FolderDescriptionDialog folder={writing} onOpenChange={(open) => !open && setWriting(null)} onSave={async () => true} />
    </main>
  )
}
