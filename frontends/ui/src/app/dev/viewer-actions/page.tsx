'use client'

/**
 * `/dev/viewer-actions` — Piloti's viewer actions (ADR-0144) through the real
 * row, the real runner and the real peek store.
 *
 * Four answers, each with the row its viewer actions leave once the answer is
 * there (the actions are held while a turn runs and released at its end):
 *   1. „Baubeschreibung S. 4“: the passage opened beside the chat, with
 *      „Zurücknehmen“; the Fassung comparison of the same answer only offered,
 *      because it would cover the chat.
 *   2. A document the reader may not see: the read answers 404, nothing moves,
 *      and the row says only that it is not available.
 *   3. The reader turned it off: the place is offered with „Anzeigen“.
 *   4. The reader was typing when it was released: offered, not opened.
 *   5. The turn still runs: the place is held, the row says it waits for the
 *      finished answer, and „Anzeigen“ opens it at once.
 * The panel on the right reads `useFilePreviewStore`, the store the chat peek
 * draws: which document is open, at which page, with what marked.
 *
 * `GET /api/documents/{id}` is stubbed over `window.fetch` at module scope.
 * Development only (the `/dev` layout 404s elsewhere).
 */

import { useEffect, useState, type FC, type ReactNode } from 'react'
import { AgentResponse } from '@/features/chat/components/AgentResponse'
import { useChatStore } from '@/features/chat/store'
import {
  noteTypedAt,
  proposeViewerAction,
  registerViewerActionRunner,
  releaseViewerActions,
  resetViewerActions,
  setViewerActionsAuto,
  type ViewerActionCall,
} from '@/features/chat/lib/viewer-actions'
import { createViewerActionRunner } from '@/features/documents/lib/viewer-action-runner'
import { useFilePreviewStore } from '@/features/documents/stores/file-preview-store'
import { I18nProvider } from '@/i18n'

const at = new Date('2026-10-27T09:15:00')

const row = (id: string, filename: string) => ({
  id,
  filename,
  displayName: null,
  fileSize: 1_200_000,
  contentType: 'application/pdf',
  status: 'ready',
  folderId: null,
  createdAt: '2026-10-20T08:00:00Z',
  pageCount: 12,
  projectId: 'proj-lacknergasse',
  collectionName: 'proj_lacknergasse',
  revision: null as null | { supersededBy: null; supersedes: { id: string; filename: string }[]; suggestion: null; changeSummary: null },
})

const VISIBLE: Record<string, ReturnType<typeof row>> = {
  'doc-bb': row('doc-bb', 'Baubeschreibung.pdf'),
  'doc-eg': {
    ...row('doc-eg', 'Grundriss EG.pdf'),
    revision: {
      supersededBy: null,
      supersedes: [{ id: 'doc-eg-alt', filename: 'Grundriss EG_Vorentwurf.pdf' }],
      suggestion: null,
      changeSummary: null,
    },
  },
  'doc-eg-alt': row('doc-eg-alt', 'Grundriss EG_Vorentwurf.pdf'),
}

if (typeof window !== 'undefined') {
  const real = window.fetch.bind(window)
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), window.location.origin)
    const match = url.pathname.match(/^\/api\/documents\/([^/]+)$/)
    if (!match) return real(input as RequestInfo, init)
    const document = VISIBLE[decodeURIComponent(match[1]!)]
    if (!document) return new Response(null, { status: 404 })
    return new Response(JSON.stringify({ document }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
}

const call = (id: string, name: ViewerActionCall['tool_call_name'], args: Partial<ViewerActionCall['args']>): ViewerActionCall => ({
  tool_call_id: id,
  tool_call_name: name,
  args: {
    document_id: 'doc-bb',
    document_name: 'Baubeschreibung.pdf',
    page: null,
    passage: null,
    region: null,
    against_document_id: null,
    against_document_name: null,
    element: null,
    ...args,
  },
})

const ANSWERS = [
  {
    id: 'answer-1',
    content: 'Laut Baubeschreibung S. 4 sind die Fluchtwege mindestens 1,20 m breit. Gegenüber dem Vorentwurf ist das Stiegenhaus im EG verschoben.',
  },
  { id: 'answer-2', content: 'Die Brandschutzauflagen stehen im Bescheid vom März, S. 2.' },
  { id: 'answer-3', content: 'Im Grundriss EG liegt der Technikraum oben rechts.' },
  { id: 'answer-4', content: 'Die Raumhöhe im DG steht in der Baubeschreibung auf S. 7.' },
  { id: 'answer-5', content: 'Die Stiegenbreite steht in der Baubeschreibung auf S. 5, und' },
]

let played: Promise<void> | null = null

async function play(): Promise<void> {
  resetViewerActions()
  useFilePreviewStore.getState().close()
  registerViewerActionRunner(
    createViewerActionRunner({
      hasRoom: () => true,
      openCompare: () => {},
      closeCompare: () => true,
      navigate: () => {},
      currentHref: () => window.location.pathname,
    })
  )
  setViewerActionsAuto(true)
  proposeViewerAction(
    'answer-1',
    call('va_1', 'highlight_passage', { page: 4, passage: 'Die Fluchtwege sind mindestens 1,20 m breit.' })
  )
  proposeViewerAction(
    'answer-1',
    call('va_2', 'compare_revisions', {
      document_id: 'doc-eg',
      document_name: 'Grundriss EG.pdf',
      against_document_id: 'doc-eg-alt',
      against_document_name: 'Grundriss EG_Vorentwurf.pdf',
    })
  )
  await releaseViewerActions('answer-1')
  proposeViewerAction('answer-2', call('va_3', 'open_document', { document_id: 'doc-secret', document_name: 'Bescheid_Brandschutz.pdf', page: 2 }))
  await releaseViewerActions('answer-2')
  setViewerActionsAuto(false)
  proposeViewerAction(
    'answer-3',
    call('va_4', 'highlight_region', { document_id: 'doc-eg', document_name: 'Grundriss EG.pdf', page: 1, region: [0.62, 0.08, 0.3, 0.22] })
  )
  await releaseViewerActions('answer-3')
  setViewerActionsAuto(true)
  noteTypedAt(Date.now() + 60_000)
  proposeViewerAction('answer-4', call('va_5', 'open_document', { page: 7 }))
  await releaseViewerActions('answer-4')
  noteTypedAt(Number.NEGATIVE_INFINITY)
  // Its turn still runs: held, never released here.
  proposeViewerAction('answer-5', call('va_6', 'highlight_passage', { page: 5, passage: 'Stiegenbreite 1,20 m' }))
}

/** What the chat peek would draw: the store it reads. */
const ViewerProbe: FC = () => {
  const file = useFilePreviewStore((state) => state.file)
  const mode = useFilePreviewStore((state) => state.mode)
  const target = useFilePreviewStore((state) => state.viewerTarget)
  return (
    <aside
      data-testid="viewer-probe"
      className="sticky top-8 flex h-fit flex-col gap-2 rounded-lg border bg-card p-4 text-xs shadow-xs"
    >
      <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Viewer neben dem Chat</p>
      {file ? (
        <>
          <p className="text-sm font-medium text-foreground">{file.filename}</p>
          <p className="text-muted-foreground">
            {mode} · Seite {target?.page ?? '–'}
          </p>
          {target?.passage && <mark className="rounded-sm bg-warning-subtle px-1 py-0.5 text-foreground">{target.passage}</mark>}
          {target?.regions && <p className="text-muted-foreground">{target.regions.length} Bereich markiert</p>}
        </>
      ) : (
        <p className="text-muted-foreground">Kein Dokument offen</p>
      )}
    </aside>
  )
}

const Block: FC<{ title: string; children: ReactNode }> = ({ title, children }) => (
  <section className="flex flex-col gap-2">
    <h2 className="text-sm font-semibold text-foreground">{title}</h2>
    {children}
  </section>
)

export default function ViewerActionsPreview() {
  const [ready, setReady] = useState(false)
  useEffect(() => {
    useChatStore.setState({ projectId: 'proj-lacknergasse' })
    // Once per page: Strict Mode runs the effect twice, and two plays interleave their typing clocks.
    played ??= play()
    void played.then(() => setReady(true))
  }, [])
  return (
    <I18nProvider initialLocale="de" fixedLocale>
      <div
        data-testid="viewer-actions-preview"
        data-ready={ready || undefined}
        className="mx-auto grid w-full max-w-5xl gap-8 p-4 sm:p-8 md:grid-cols-[minmax(0,1fr)_16rem]"
      >
        <div className="flex min-w-0 flex-col gap-8">
          {ANSWERS.map((answer, index) => (
            <Block
              key={answer.id}
              title={
                [
                  'Geöffnet, mit Zurücknehmen; der Vergleich nur angeboten',
                  'Kein Zugriff: nichts bewegt',
                  'Automatisch aus: angeboten',
                  'Während des Schreibens: angeboten',
                  'Die Antwort läuft noch: gehalten, mit Anzeigen',
                ][index]!
              }
            >
              <AgentResponse content={answer.content} messageId={answer.id} timestamp={at} />
            </Block>
          ))}
        </div>
        <ViewerProbe />
      </div>
    </I18nProvider>
  )
}
