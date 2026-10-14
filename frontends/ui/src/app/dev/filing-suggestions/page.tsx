'use client'

/**
 * Dev preview: Piloti files the uploads into described folders, and proposes
 * it rather than doing it (`docs/ux/file-upload-and-explorer.md`, „Ordner, die
 * sagen, was hineingehört").
 *
 *   1. The upload tray, while the person is still there: the suggestion lands
 *      on the row of the file it is about, with one click to move it there
 *      and one to leave it.
 *   2. The same suggestion on the file's row in the detail view, and on its
 *      card, one proposal per target folder („Alle 2 verschieben").
 *   3. A folder that does not exist yet: „Anlegen und verschieben".
 *   4. A reader who may not move files sees the suggestion and no buttons.
 *   5. A folder's description at the top of the folder, in its three states
 *      (described and writable, undescribed and writable, described and
 *      read-only), and the dialog it is written in.
 *
 * Nothing leaves the browser: a fetch shim answers `/api/proposals/{id}` and
 * its apply and dismiss, so the buttons can be pressed. Not linked from
 * anywhere; the `/dev` layout 404s it outside development.
 */

import type { JSX, ReactNode } from 'react'
import { useState } from 'react'
import { FileListView } from '@/features/documents/components/file-list-view'
import { FileCard } from '@/features/documents/components/file-card'
import { FileGrid } from '@/features/documents/components/file-grid'
import { FilingSuggestionsProvider } from '@/features/documents/components/filing-suggestion'
import { FolderDescriptionDialog, FolderDescriptionLine } from '@/features/documents/components/folder-description-dialog'
import { UploadTray } from '@/features/documents/components/upload-tray'
import type { FileItem, FolderItem } from '@/features/documents/file-types'
import { suggestionsByDocument } from '@/features/documents/lib/filing-suggestions'
import type { TrackedFile } from '@/features/documents/types'
import type { ListedProposal, ProposedChangeView } from '@/lib/proposals/types'

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

const BESCHEIDE = proposal('00000000-0000-4000-8000-0000000000f1', {
  payload: {
    operation: 'move',
    operations: [
      {
        document: 'MA37_Baubewilligung_2026-09.pdf',
        source: 'projekt',
        target_folder: 'Behörde/Bescheide',
        reason: 'Ein Bescheid der MA 37; „Bescheide“ hält laut Beschreibung Bescheide und Stellungnahmen.',
      },
      {
        document: 'Stellungnahme_MA22.pdf',
        source: 'projekt',
        target_folder: 'Behörde/Bescheide',
        reason: 'Eine Stellungnahme der MA 22 zum Bauverfahren.',
      },
    ],
    basis: 'name',
  },
})

const KORRESPONDENZ = proposal('00000000-0000-4000-8000-0000000000f2', {
  payload: {
    operation: 'move',
    operations: [
      {
        document: 'Schreiben_Fristerstreckung.pdf',
        source: 'projekt',
        target_folder: 'Korrespondenz',
        reason: 'Ein Brief an die Behörde; das Büro legt Briefe in vier Projekten unter „Korrespondenz“ ab.',
      },
    ],
    basis: 'content',
    new_folder: { path: 'Korrespondenz', description: 'Briefe und Mails mit Behörden und Bauherrschaft' },
  },
})

const LISTED: ListedProposal[] = [
  {
    proposal: BESCHEIDE,
    documents: [
      { id: 'doc-bescheid', name: 'MA37_Baubewilligung_2026-09.pdf' },
      { id: 'doc-stellungnahme', name: 'Stellungnahme_MA22.pdf' },
    ],
  },
  { proposal: KORRESPONDENZ, documents: [{ id: 'doc-brief', name: 'Schreiben_Fristerstreckung.pdf' }] },
]

/** The same suggestions, held under ids of their own, for a reader the server says may not decide. */
const READ_ONLY: ListedProposal[] = LISTED.map((entry, index) => ({
  ...entry,
  proposal: { ...entry.proposal, id: `00000000-0000-4000-8000-0000000000e${index}`, canDecide: false },
}))

/** The server's proposals, as the shim answers them; a press moves them on. */
const store = new Map<string, FileProposal>(
  [BESCHEIDE, KORRESPONDENZ, ...READ_ONLY.map((entry) => entry.proposal)].flatMap((entry) =>
    entry.kind === 'file_operation' ? [[entry.id, entry] as const] : []
  )
)

function shimAnswer(url: string, method: string): Response | null {
  const match = /\/api\/proposals\/([^/?]+)(\/apply|\/dismiss)?$/.exec(new URL(url, 'http://dev').pathname)
  if (!match) return null
  const current = store.get(match[1])
  if (!current) return null
  if (method === 'POST' && match[2]) {
    const applied = match[2] === '/apply'
    const next: FileProposal = {
      ...current,
      status: applied ? 'applied' : 'dismissed',
      decidedBy: 'user_me',
      decidedByName: 'Mia Huber',
      decidedAt: new Date().toISOString(),
      canDecide: false,
      results: applied ? current.payload.operations.map((item) => ({ label: item.document ?? '', ok: true })) : null,
    }
    store.set(next.id, next)
    return Response.json({ proposal: next })
  }
  return Response.json({ proposal: current })
}

if (typeof window !== 'undefined' && process.env.NODE_ENV === 'development') {
  const w = window as unknown as { __filingShim?: boolean }
  if (!w.__filingShim) {
    w.__filingShim = true
    const real = window.fetch.bind(window)
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      return shimAnswer(url, init?.method ?? 'GET') ?? real(input, init)
    }
  }
}

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
  tracked('t3', 'Einreichplan_EG.pdf', 'doc-eg', 3.2 * MB),
]

const doc = (id: string, filename: string, summary: string | null): FileItem => ({
  id,
  filename,
  displayName: null,
  fileSize: 1.2 * MB,
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

const LISTING: FileItem[] = [
  doc('doc-bescheid', 'MA37_Baubewilligung_2026-09.pdf', 'Baubewilligung für den Zubau, mit Auflagen zum Brandschutz.'),
  doc('doc-stellungnahme', 'Stellungnahme_MA22.pdf', 'Stellungnahme der Umweltschutzabteilung zum Baumbestand.'),
  doc('doc-brief', 'Schreiben_Fristerstreckung.pdf', 'Ansuchen um Erstreckung der Frist für die Nachreichung.'),
  doc('doc-eg', 'Einreichplan_EG.pdf', 'Grundriss Erdgeschoß, Einreichung.'),
]

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
      <div className="bg-card overflow-hidden rounded-xl border">{children}</div>
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

export default function FilingSuggestionsDevPage(): JSX.Element {
  const [writing, setWriting] = useState<FolderItem | null>(null)
  const byDocument = suggestionsByDocument(LISTED)
  const readOnly = suggestionsByDocument(READ_ONLY)

  return (
    <main className="mx-auto flex max-w-4xl flex-col gap-8 p-4 sm:p-6">
      <div>
        <h1 className="text-lg font-semibold">Ablagevorschläge</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Piloti schlägt vor, in welchen beschriebenen Ordner ein Upload gehört. Eine Person bestätigt pro Ordner.
        </p>
      </div>

      <FilingSuggestionsProvider byDocument={byDocument} onSettled={noop}>
        <Stage
          title="1 · Im Upload, solange die Person da ist"
          note="Nach dem Dateinamen und den Ordnerbeschreibungen, Sekunden nach dem letzten Byte."
        >
          <UploadTray files={TRAY} onRetry={noop} onDismiss={noop} />
        </Stage>

        <Stage
          title="2 · In der Liste und auf der Karte"
          note="Ein Vorschlag pro Zielordner: ein Klick verschiebt alle Dateien, die dorthin gehören."
        >
          <FileListView files={LISTING} selectedFileId={null} onSelectFile={noop} />
          <div className="border-t p-4">
            <FileGrid>
              <FileCard file={LISTING[0]} isSelected={false} onSelect={noop} locale="de" />
              <FileCard file={LISTING[2]} isSelected={false} onSelect={noop} locale="de" />
            </FileGrid>
          </div>
        </Stage>
      </FilingSuggestionsProvider>

      <FilingSuggestionsProvider byDocument={readOnly} onSettled={noop}>
        <Stage title="3 · Wer nur lesen darf" note="Der Vorschlag, ohne Knöpfe.">
          <FileListView files={LISTING.slice(0, 1)} selectedFileId={null} onSelectFile={noop} />
        </Stage>
      </FilingSuggestionsProvider>

      <Stage
        title="4 · Was in einen Ordner gehört"
        note="Oben im Ordner: die Beschreibung, und für wer schreiben darf, der Weg sie zu ändern."
      >
        <div className="divide-y">
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
