'use client'

/**
 * `/dev/file-browser?variant=fassungen` — documents with Fassungen, as the
 * listing draws them (ADR-0098, `fassung-chain.ts`).
 *
 * Three panes over one corpus, each filtered the way the workspace filters:
 *
 *  a. Kacheln, older Fassungen hidden (the default): one card per document,
 *     „3 Fassungen" on the name line, the approval state below it.
 *  b. Kacheln with „Ältere Fassungen" shown: the older ones appear with ONE
 *     badge, „Ältere Fassung", whose tooltip names what replaced it. One of
 *     them failed to read, one carries a same-name history of its own.
 *  c. The same in the list: every row one line tall, the count beside the
 *     name, never in the „Freigabe" column.
 *
 * German by default, the copy that has to fit; `&lang=en` for English.
 * `&section=a|b|c` shows one pane, for captures.
 */

import type { JSX } from 'react'
import { useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { FileBrowserPane } from '@/features/documents/components/file-browser-pane'
import { useFileSearch } from '@/features/documents/hooks/use-file-search'
import { withoutOlderFassungen } from '@/features/documents/lib/fassung-chain'
import { projectSearchScope } from '@/features/documents/lib/file-shelf'
import type { FileItem } from '@/features/documents/file-types'
import { EMPTY_FASSUNG, type FassungFacts, type FassungRef } from '@/lib/documents/fassung'
import { I18nProvider } from '@/i18n'

const ref = (id: string, filename: string): FassungRef => ({ id, filename })
const history = (...refs: FassungRef[]): FassungFacts['history'] =>
  refs.map((entry) => ({ ...entry, createdAt: '2026-07-02T09:00:00Z', changeSummary: null }))

const C = ref('grundriss-c', 'Grundriss_EG_Index_C.pdf')
const B = ref('grundriss-b', 'Grundriss_EG_Index_B.pdf')
const A = ref('grundriss-a', 'Grundriss_EG_Index_A.pdf')
const SCHNITT_B = ref('schnitt-b', 'Schnitt_A-A_Index_B.pdf')
const SCHNITT_A = ref('schnitt-a', 'Schnitt_A-A_Index_A.pdf')
const LAGEPLAN_D = ref(
  'lageplan-d',
  'Lageplan_mit_Grundstücksgrenzen_Höhenkoten_und_Leitungsbestand_Index_D_2026-09-14.pdf'
)
const LAGEPLAN_C = ref('lageplan-c', 'Lageplan_mit_Grundstücksgrenzen_Index_C.pdf')

function row(id: string, filename: string, extra: Partial<FileItem> = {}): FileItem {
  return {
    id,
    filename,
    displayName: null,
    fileSize: 2_400_000,
    contentType: 'application/pdf',
    status: 'ready',
    folderId: null,
    createdAt: '2026-09-14T09:00:00Z',
    errorMessage: null,
    summary: null,
    pageCount: 4,
    chunkCount: 12,
    contentTypes: ['drawing', 'text'],
    tags: null,
    topics: null,
    capture: null,
    ...extra,
  }
}

export const FASSUNG_FILES: FileItem[] = [
  // Three Fassungen, and a published same-name history of its own.
  row(C.id, C.filename, {
    summary: 'Grundriss Erdgeschoß Index C mit Stellplatzzufahrt und verschobener Technikraumtür.',
    versionState: 'published',
    versionCount: 3,
    createdAt: '2026-09-20T10:00:00Z',
    fassung: { ...EMPTY_FASSUNG, supersedes: [B], history: history(B, A) },
  }),
  row(SCHNITT_B.id, SCHNITT_B.filename, {
    summary: 'Schnitt A-A Index B mit angepasster Attikahöhe.',
    versionState: 'draft',
    versionCount: 2,
    createdAt: '2026-09-18T10:00:00Z',
    fassung: { ...EMPTY_FASSUNG, supersedes: [SCHNITT_A], history: history(SCHNITT_A) },
  }),
  // A long German name: the count must not push it off the card.
  row(LAGEPLAN_D.id, LAGEPLAN_D.filename, {
    summary: 'Lageplan mit Grundstücksgrenzen, Höhenkoten und dem Leitungsbestand der Stadtwerke.',
    createdAt: '2026-09-14T10:00:00Z',
    fassung: { ...EMPTY_FASSUNG, supersedes: [LAGEPLAN_C], history: history(LAGEPLAN_C) },
  }),
  row('baubeschreibung', 'Baubeschreibung.pdf', {
    summary: 'Baubeschreibung mit Konstruktion, Haustechnik und Ausstattung.',
    contentTypes: ['text'],
    createdAt: '2026-09-10T10:00:00Z',
  }),
  // The older Fassungen. Only visible with „Ältere Fassungen" on.
  row(B.id, B.filename, {
    summary: 'Grundriss Erdgeschoß Index B, noch ohne Stellplatzzufahrt.',
    versionState: 'superseded',
    versionCount: 2,
    createdAt: '2026-08-02T10:00:00Z',
    fassung: { ...EMPTY_FASSUNG, supersededBy: C, supersedes: [A] },
  }),
  row(A.id, A.filename, {
    summary: 'Grundriss Erdgeschoß Index A, Vorentwurf.',
    createdAt: '2026-07-02T10:00:00Z',
    fassung: { ...EMPTY_FASSUNG, supersededBy: B },
  }),
  row(SCHNITT_A.id, SCHNITT_A.filename, {
    status: 'failed',
    errorMessage: 'Die Datei ist beschädigt.',
    summary: null,
    createdAt: '2026-07-20T10:00:00Z',
    fassung: { ...EMPTY_FASSUNG, supersededBy: SCHNITT_B },
  }),
  row(LAGEPLAN_C.id, LAGEPLAN_C.filename, {
    summary: 'Lageplan Index C.',
    createdAt: '2026-06-30T10:00:00Z',
    fassung: { ...EMPTY_FASSUNG, supersededBy: LAGEPLAN_D },
  }),
]

const PANES = [
  { id: 'a', title: 'Kacheln · ältere Fassungen ausgeblendet', view: 'cards', showOlder: false },
  { id: 'b', title: 'Kacheln · „Ältere Fassungen“ gezeigt', view: 'cards', showOlder: true },
  { id: 'c', title: 'Liste · „Ältere Fassungen“ gezeigt', view: 'list', showOlder: true },
] as const

function Pane({ view, showOlder }: { view: 'cards' | 'list'; showOlder: boolean }): JSX.Element {
  const [selected, setSelected] = useState<string | null>(null)
  const search = useFileSearch(projectSearchScope('proj-demo'))
  // What the workspace hands the pane: the older ones leave unless asked for.
  const files = withoutOlderFassungen(FASSUNG_FILES, showOlder)
  return (
    <FileBrowserPane
      files={files}
      searchFiles={FASSUNG_FILES}
      selectedFileId={selected}
      onSelectFile={setSelected}
      isLoading={false}
      search={search}
      view={view}
      showOlderFassungen={showOlder}
    />
  )
}

export function FassungenFixture(): JSX.Element {
  const params = useSearchParams()
  const locale = params?.get('lang') === 'en' ? 'en' : 'de'
  const only = params?.get('section')
  const panes = PANES.filter((pane) => !only || pane.id === only)
  return (
    <I18nProvider initialLocale={locale} fixedLocale>
      <main className="mx-auto flex max-w-5xl flex-col gap-8 p-6">
        {!only && (
          <div>
            <h1 className="text-lg font-semibold">Files browser — Fassungen</h1>
            <p className="text-muted-foreground mt-1 text-sm">
              One entry per document; the count beside the name; one badge on an older Fassung.
            </p>
          </div>
        )}
        {panes.map((pane) => (
          <section
            key={pane.id}
            className="flex flex-col gap-2"
            data-testid={`fassungen-${pane.id}`}
          >
            <h2 className="text-muted-foreground text-sm font-medium">{pane.title}</h2>
            <div className="overflow-hidden rounded-xl border">
              <Pane view={pane.view} showOlder={pane.showOlder} />
            </div>
          </section>
        ))}
      </main>
    </I18nProvider>
  )
}
