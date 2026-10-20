'use client'

/**
 * Dev preview for „Fassungen und Freigabe", the one section that says what a
 * document has been and where it stands now, framed at the rail's REAL width:
 * a 280px rail with p-4 on the sunken surface, so 248px of content. (A wider
 * card frame once hid every wrap the real rail has.)
 *
 * One block per question a reader arrives with:
 *
 *  - plain:      a single upload. No state word, no track: nobody approved it.
 *  - same:       three uploads under one name, numbered Fassung 3, 2, 1.
 *  - cross:      Index C with Index B and A linked under other names.
 *  - mixed:      both histories at once, merged by date.
 *  - review:     a report in review while Fassung 1 stays published; the
 *                round was sent to Sabine Gruber.
 *  - changes:    changes requested, with the reviewer's words.
 *  - replaced:   an older Fassung, opened: the newer document is the top row.
 *  - suggestion: Piloti's suggestion that this replaces another.
 *  - long:       long file names, middle-truncated; approved, waiting to be
 *                published.
 *
 * `?state=<id>` shows one block, for captures; `?open=1` opens the sections
 * that are shut at rest; `?locale=en` renders English.
 *
 * The section takes its client as a prop, so this page needs no backend. The
 * buttons that call the real routes (linking, deciding) fail here. 404s outside
 * development.
 */

import type { JSX, ReactNode } from 'react'
import { Suspense, useEffect } from 'react'
import { notFound, useSearchParams } from 'next/navigation'
import { I18nProvider } from '@/i18n'
import { DocumentRevisions } from '@/features/documents/components/document-revisions'
import type { FileItem } from '@/features/documents/file-types'
import { EMPTY_REVISION_LINKS } from '@/lib/documents/revision-links'
import type { DocumentLifecycleClient } from '@/lib/documents/lifecycle-client'
import type { DocumentVersionListResponse, DocumentVersionState, DocumentVersionView } from '@/lib/documents/lifecycle-types'

const ANNA = 'user_anna'
const MARKUS = 'user_markus'
const SABINE = 'user_sabine'
const CLARA = 'user_clara'
const ME = 'user_me'
/** What the listing resolves for the people who acted (`DocumentVersionListResponse.people`). */
const PEOPLE = [
  { userId: ANNA, name: 'Anna Berger' },
  { userId: MARKUS, name: 'Markus Feld' },
  { userId: SABINE, name: 'Sabine Gruber' },
  { userId: CLARA, name: 'Clara Schmid' },
  { userId: ME, name: 'Miriam Hofer' },
]

function version(
  documentId: string,
  versionNumber: number,
  state: DocumentVersionState,
  createdAt: string,
  overrides: Partial<DocumentVersionView> = {},
): DocumentVersionView {
  return {
    id: `${documentId}_v${versionNumber}`,
    documentId,
    versionNumber,
    state,
    contentType: 'application/pdf',
    fileSize: 18_400,
    contentHash: `sha256:${documentId}${versionNumber}`,
    submittedBy: null,
    submittedAt: null,
    reviewedBy: null,
    reviewedAt: null,
    approvedBy: null,
    approvedAt: null,
    publishedBy: null,
    publishedAt: null,
    reviewComment: null,
    createdBy: ANNA,
    createdAt,
    updatedAt: createdAt,
    ...overrides,
  }
}

/** A person's upload, as the server stores it: born published, approved by nobody (migration 0137). */
function upload(documentId: string, versionNumber: number, createdAt: string, by: string, state: DocumentVersionState = 'published') {
  return version(documentId, versionNumber, state, createdAt, {
    createdBy: by,
    publishedBy: by,
    publishedAt: createdAt,
  })
}

function fixtureClient(
  documentId: string,
  versions: DocumentVersionView[],
  overrides: Partial<DocumentVersionListResponse> = {},
): DocumentLifecycleClient {
  const listing: DocumentVersionListResponse = {
    documentId,
    lifecycle: 'active',
    publishedVersionId: versions.find((row) => row.state === 'published')?.id ?? null,
    versions,
    reviewerUserIds: [],
    people: PEOPLE,
    ...overrides,
  }
  const refuse = () => Promise.reject(new Error('preview'))
  return {
    listVersions: () => Promise.resolve(listing),
    getVersion: refuse,
    forkDraft: refuse,
    replaceContent: refuse,
    submit: refuse,
    approve: refuse,
    requestChanges: refuse,
    reject: refuse,
    publish: refuse,
    archive: refuse,
    diff: refuse,
  } as DocumentLifecycleClient
}

function file(id: string, filename: string, overrides: Partial<FileItem> = {}): FileItem {
  return {
    id,
    filename,
    displayName: null,
    fileSize: 2_400_000,
    contentType: 'application/pdf',
    status: 'ready',
    folderId: null,
    createdAt: '2026-09-02T07:30:00.000Z',
    errorMessage: null,
    summary: null,
    pageCount: 3,
    chunkCount: 12,
    contentTypes: null,
    tags: null,
    topics: null,
    capture: null,
    ...overrides,
  }
}

const WRITER = { permissions: ['project:view', 'project:documents:write'] as const, userId: ME }
const REVIEWER = { permissions: ['project:view', 'project:edit', 'project:documents:write'] as const, userId: ME }

const INDEX_B = 'EG_Grundriss_Index_B_2026-07-02.pdf'
const INDEX_A = 'EG_Grundriss_Index_A_2026-05-20.pdf'
const INDEX_C = 'EG_Grundriss_Index_C_2026-09-02.pdf'
const CROSS_HISTORY = [
  {
    id: 'doc_b',
    filename: INDEX_B,
    createdAt: '2026-07-02T09:10:00Z',
    changeSummary: '- Fluchtweg über das Stiegenhaus B ergänzt\n- Brandabschnitte nach Gutachten angepasst',
  },
  { id: 'doc_a', filename: INDEX_A, createdAt: '2026-05-20T14:00:00Z', changeSummary: null },
]
const CROSS_FACTS = {
  ...EMPTY_REVISION_LINKS,
  supersedes: [{ id: 'doc_b', filename: INDEX_B }],
  history: CROSS_HISTORY,
  changeSummary: {
    text: '- Stellplatzzufahrt neu an der Nordseite\n- Brandabschnitt zwischen Stiege A und Tiefgarage verschoben',
    basis: 'previous' as const,
  },
}

interface Block {
  id: string
  title: string
  note: string
  render: () => ReactNode
}

const BLOCKS: readonly Block[] = [
  {
    id: 'plain',
    title: 'Eine Datei, einmal hochgeladen',
    note: 'Kein Statuswort, kein Freigabe-Balken: Niemand hat sie freigegeben, sie ist einfach hochgeladen. Piloti antwortet aus ihr.',
    render: () => (
      <DocumentRevisions
        file={file('doc_plain', 'Aktenvermerk_Fluchtwege.pdf')}
        canManage
        viewer={WRITER}
        client={fixtureClient('doc_plain', [upload('doc_plain', 1, '2026-09-02T07:30:00Z', ANNA)])}
      />
    ),
  },
  {
    id: 'same',
    title: 'Drei Uploads unter einem Namen',
    note: 'Fassung 3, 2, 1, die neueste zuerst. Datum und Person stehen einmal, auf der Zeile.',
    render: () => (
      <DocumentRevisions
        file={file('doc_same', 'Baubeschreibung.pdf', { versionCount: 3 })}
        canManage
        viewer={WRITER}
        client={fixtureClient('doc_same', [
          upload('doc_same', 1, '2026-08-10T08:15:00Z', ME, 'superseded'),
          upload('doc_same', 2, '2026-08-24T10:40:00Z', ANNA, 'superseded'),
          upload('doc_same', 3, '2026-09-02T07:30:00Z', ANNA),
        ])}
      />
    ),
  },
  {
    id: 'cross',
    title: 'Index C, mit Index B und A verknüpft',
    note: 'Ältere Dokumente unter anderen Namen, als Fassung 2 und 1 nummeriert; der Index ist der Zusatz.',
    render: () => (
      <DocumentRevisions
        file={file('doc_cross', INDEX_C, { fassung: CROSS_FACTS })}
        canManage
        viewer={WRITER}
        client={fixtureClient('doc_cross', [upload('doc_cross', 1, '2026-09-02T07:30:00Z', ANNA)])}
        onOpenDocument={() => undefined}
      />
    ),
  },
  {
    id: 'mixed',
    title: 'Beides: drei Uploads und zwei verknüpfte Dokumente',
    note: 'Eine Zeitleiste, nach Datum gemischt, durchnummeriert.',
    render: () => (
      <DocumentRevisions
        file={file('doc_mixed', INDEX_C, { versionCount: 3, fassung: CROSS_FACTS })}
        canManage
        viewer={WRITER}
        client={fixtureClient('doc_mixed', [
          upload('doc_mixed', 1, '2026-08-10T08:15:00Z', ME, 'superseded'),
          upload('doc_mixed', 2, '2026-08-24T10:40:00Z', ANNA, 'superseded'),
          upload('doc_mixed', 3, '2026-09-02T07:30:00Z', ANNA),
        ])}
        onOpenDocument={() => undefined}
      />
    ),
  },
  {
    id: 'review',
    title: 'In Prüfung, Fassung 1 bleibt veröffentlicht',
    note: 'Der Kopf spricht über die neueste Fassung und sagt in einem Satz, dass Piloti weiter aus Fassung 1 antwortet. Die Runde ging an Sabine Gruber.',
    render: () => (
      <DocumentRevisions
        file={file('doc_review', 'Brandschutzkonzept.md', { contentType: 'text/markdown', authoredBy: 'agent', versionCount: 2 })}
        canManage
        viewer={REVIEWER}
        client={fixtureClient(
          'doc_review',
          [
            version('doc_review', 1, 'published', '2026-08-20T08:00:00Z', {
              createdBy: ME,
              submittedBy: ME,
              submittedAt: '2026-08-20T08:30:00Z',
              approvedBy: MARKUS,
              approvedAt: '2026-08-21T09:00:00Z',
              publishedBy: MARKUS,
              publishedAt: '2026-08-21T09:05:00Z',
            }),
            version('doc_review', 2, 'in_review', '2026-09-03T07:00:00Z', {
              createdBy: ME,
              contentType: 'text/markdown',
              submittedBy: ANNA,
              submittedAt: '2026-09-03T10:15:00Z',
            }),
          ],
          { reviewerUserIds: [SABINE] },
        )}
      />
    ),
  },
  {
    id: 'changes',
    title: 'Änderungen angefordert',
    note: 'Wer überarbeitet, mit Namen; die Worte der Prüferin auf der Fassung, um die es geht.',
    render: () => (
      <DocumentRevisions
        file={file('doc_changes', 'Statik_Vorbemessung.pdf', { versionCount: 2 })}
        canManage
        viewer={WRITER}
        client={fixtureClient('doc_changes', [
          version('doc_changes', 1, 'published', '2026-08-12T08:00:00Z', {
            submittedBy: ANNA,
            submittedAt: '2026-08-12T08:30:00Z',
            approvedBy: CLARA,
            approvedAt: '2026-08-13T11:00:00Z',
            publishedBy: CLARA,
            publishedAt: '2026-08-13T11:05:00Z',
          }),
          version('doc_changes', 2, 'changes_requested', '2026-09-04T07:00:00Z', {
            submittedBy: ANNA,
            submittedAt: '2026-09-04T09:00:00Z',
            reviewedBy: CLARA,
            reviewedAt: '2026-09-05T10:00:00Z',
            reviewComment: 'Bitte die Lastannahmen für das Flachdach ergänzen.',
          }),
        ])}
      />
    ),
  },
  {
    id: 'replaced',
    title: 'Eine ältere Fassung, geöffnet',
    note: 'Ersetzt, ohne grünen Balken. Die neuere steht als oberste Zeile, mit Öffnen.',
    render: () => (
      <DocumentRevisions
        file={file('doc_old', INDEX_B, {
          createdAt: '2026-07-02T09:10:00Z',
          fassung: { ...EMPTY_REVISION_LINKS, supersededBy: { id: 'doc_cross', filename: INDEX_C } },
        })}
        canManage
        viewer={WRITER}
        client={fixtureClient('doc_old', [upload('doc_old', 1, '2026-07-02T09:10:00Z', MARKUS)])}
        onOpenDocument={() => undefined}
      />
    ),
  },
  {
    id: 'suggestion',
    title: 'Piloti schlägt eine Verknüpfung vor',
    note: 'Öffnet sich von selbst, mit der einen Frage. Nichts ändert sich für Antworten, bis jemand bestätigt.',
    render: () => (
      <DocumentRevisions
        file={file('doc_suggest', 'Erdgeschoss_Einreichung_final.pdf', {
          createdAt: '2026-09-30T10:00:00Z',
          fassung: {
            ...EMPTY_REVISION_LINKS,
            suggestion: {
              of: { id: 'doc_cross', filename: INDEX_C },
              confidence: 0.86,
              reason: 'Gleiches Geschoß und gleicher Inhalt; zusätzlich ein geänderter Müllraum.',
              basis: 'content',
            },
          },
        })}
        canManage
        viewer={WRITER}
        client={fixtureClient('doc_suggest', [upload('doc_suggest', 1, '2026-09-30T10:00:00Z', ME)])}
      />
    ),
  },
  {
    id: 'long',
    title: 'Lange Dateinamen, freigegeben',
    note: 'Der Name wird in der Mitte gekürzt, Index und Endung bleiben stehen. Nächster Schritt: Veröffentlichung.',
    render: () => {
      const older = 'Wohnanlage-Schlosspark_Bauteil-B_Grundriss_1OG_Einreichung_Index-C_2026-06-30.pdf'
      const oldest = 'Wohnanlage-Schlosspark_Bauteil-B_Grundriss_1OG_Vorentwurf_Index-B_2026-04-11.pdf'
      return (
        <DocumentRevisions
          file={file('doc_long', 'Wohnanlage-Schlosspark_Bauteil-B_Grundriss_1OG_Einreichung_Index-D_2026-08-14.pdf', {
            fassung: {
              ...EMPTY_REVISION_LINKS,
              supersedes: [{ id: 'doc_long_c', filename: older }],
              history: [
                { id: 'doc_long_c', filename: older, createdAt: '2026-06-30T08:00:00Z', changeSummary: null },
                { id: 'doc_long_b', filename: oldest, createdAt: '2026-04-11T08:00:00Z', changeSummary: null },
              ],
            },
          })}
          canManage
          viewer={WRITER}
          client={fixtureClient('doc_long', [
            version('doc_long', 1, 'approved', '2026-08-14T08:00:00Z', {
              submittedBy: ANNA,
              submittedAt: '2026-08-14T09:00:00Z',
              reviewedBy: MARKUS,
              reviewedAt: '2026-08-15T10:00:00Z',
              approvedBy: MARKUS,
              approvedAt: '2026-08-15T10:00:00Z',
            }),
          ])}
          onOpenDocument={() => undefined}
        />
      )
    },
  },
]

function Frame({ block }: { block: Block }): JSX.Element {
  return (
    <section className="flex w-[280px] flex-col gap-2 phone:w-full" data-preview-block={block.id}>
      <h2 className="text-foreground text-sm font-medium">{block.title}</h2>
      <p className="text-muted-foreground text-xs">{block.note}</p>
      {/* The rail itself: 280px, p-4, the sunken surface, no card border. */}
      <div className="bg-surface-sunken w-[280px] p-4 phone:w-full" data-preview-rail>
        {block.render()}
      </div>
    </section>
  )
}

/** Opens the sections that are shut at rest, once, so a capture shows the timeline. */
function OpenShut({ enabled }: { enabled: boolean }): null {
  useEffect(() => {
    if (!enabled) return
    const timer = setInterval(() => {
      const toggles = document.querySelectorAll<HTMLButtonElement>('[data-testid="document-fassungen-toggle"]')
      if (toggles.length === 0) return
      toggles.forEach((toggle) => {
        if (toggle.getAttribute('aria-expanded') === 'false') toggle.click()
      })
      if ([...toggles].every((toggle) => toggle.getAttribute('aria-expanded') === 'true')) clearInterval(timer)
    }, 150)
    return () => clearInterval(timer)
  }, [enabled])
  return null
}

function RevisionsPreview(): JSX.Element {
  const params = useSearchParams()
  const requested = params?.get('state')
  const only = BLOCKS.find((block) => block.id === requested) ?? null
  const locale = params?.get('locale') === 'en' ? 'en' : 'de'

  return (
    <I18nProvider key={locale} initialLocale={locale} fixedLocale>
      <OpenShut enabled={params?.get('open') === '1'} />
      <main className="bg-background min-h-dvh">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-10 px-4 py-8 sm:px-6">
          {only === null && (
            <header className="flex flex-col gap-1">
              <p className="text-muted-foreground text-xs">Dev-Vorschau</p>
              <h1 className="text-foreground text-xl font-semibold tracking-[-0.01em]">Fassungen und Freigabe</h1>
            </header>
          )}
          <div className="flex flex-wrap items-start gap-8">
            {(only ? [only] : BLOCKS).map((block) => (
              <Frame key={block.id} block={block} />
            ))}
          </div>
        </div>
      </main>
    </I18nProvider>
  )
}

export default function RevisionsDevPage(): JSX.Element {
  if (process.env.NODE_ENV !== 'development') {
    notFound()
  }
  // `useSearchParams` needs a Suspense boundary in the app router.
  return (
    <Suspense fallback={<div />}>
      <RevisionsPreview />
    </Suspense>
  )
}
