'use client'

/**
 * Dev preview for the DocumentAnswerCard (the chat `document_grid` surfacing card).
 * Renders the REAL component with fixture data so the layout can be reviewed and
 * screenshotted without a backend. A module-scope fetch shim (browser + dev only)
 * serves the project/Archiv document lists the resolution hook fetches and 404s
 * thumbnails so the deterministic SVG sketch fallback renders. Not linked from
 * anywhere and 404s outside development.
 */

import type { JSX } from 'react'
import { notFound } from 'next/navigation'
import { DocumentAnswerCard } from '@/features/grid-cards/components/DocumentAnswerCard'

function makeRow(id: string, filename: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    filename,
    fileSize: 2_400_000,
    contentType: 'application/pdf',
    status: 'ready',
    folderId: null,
    createdAt: '2026-06-14T09:00:00Z',
    errorMessage: null,
    summary: null,
    pageCount: 24,
    chunkCount: 48,
    contentTypes: ['text', 'table'],
    tags: null,
    ...extra,
  }
}

const PROJECT_ROWS = [
  makeRow('p1', 'Brandschutzkonzept_Wohnbau-Nord.pdf', {
    fileSize: 3_800_000,
    summary: 'Brandschutzkonzept für den Wohnbau Nord (GK 4) mit Fluchtweg- und Abschnittsnachweis.',
  }),
  makeRow('p2', 'Fluchtwegplan_EG-2OG.pdf', {
    fileSize: 1_200_000,
    summary: 'Fluchtwegplan für Erdgeschoss bis 2. Obergeschoss mit Notausgängen und Sammelstelle.',
  }),
  makeRow('p3', 'Grundriss_Regelgeschoss.dwg', {
    contentType: 'application/acad',
    fileSize: 5_600_000,
    summary: 'CAD-Grundriss des Regelgeschosses mit Wohnungstrennwänden und Erschließungskern.',
  }),
  makeRow('p4', 'Fassadenschnitt_Nord.png', {
    contentType: 'image/png',
    fileSize: 4_100_000,
    summary: 'Fassadenschnitt der Nordseite mit Fensteranordnung und Fluchtbalkon.',
  }),
]

const OFFICE_SHELF_ROWS = [
  makeRow('a1', 'Referenzprojekt_Stadthaus-Wien.pdf', {
    fileSize: 6_900_000,
    summary: 'Vergleichbares Wohngebäude der GK 4 mit innenliegendem Sicherheitstreppenhaus.',
  }),
  makeRow('a2', 'Detailkatalog_Treppen.pdf', {
    fileSize: 2_100_000,
    summary: 'Regeldetails für Treppenläufe, Steigungsverhältnisse und Geländerhöhen.',
  }),
]

// Install the fetch shim at module scope (before any component effect fires) so
// the resolution hook always sees the fixtures. Idempotent + dev/browser-guarded.
if (typeof window !== 'undefined' && process.env.NODE_ENV === 'development') {
  const w = window as unknown as { __docAnswerShim?: boolean }
  if (!w.__docAnswerShim) {
    w.__docAnswerShim = true
    const real = window.fetch.bind(window)
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.includes('scope=office_shelf') || String(init?.body ?? '').includes('office_shelf')) {
        return Response.json({ documents: OFFICE_SHELF_ROWS, collectionName: 'archiv_org', canManage: false })
      }
      if (url.startsWith('/api/documents?')) {
        return Response.json({ documents: PROJECT_ROWS })
      }
      if (/\/api\/documents\/.+\/thumbnail$/.test(url)) {
        return new Response(null, { status: 404 })
      }
      if (/\/api\/documents\/.+\/preview$/.test(url)) {
        return Response.json({ url: 'about:blank' })
      }
      return real(input, init)
    }
  }
}

export default function DocumentAnswerDevPage(): JSX.Element {
  if (process.env.NODE_ENV !== 'development') {
    notFound()
  }

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-10 p-8">
      <div>
        <h1 className="text-lg font-semibold">document_grid — chat surfacing card</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Files the assistant asked you to look at — FileCard thumbnails, not a
          filename list. One file peeks. Several close matches are a short grid.
        </p>
      </div>

      {/* One file — same card, receipt + peek. */}
      <DocumentAnswerCard
        title="Brandschutzkonzept_Wohnbau-Nord.pdf"
        query="Brandschutzkonzept"
        projectId="proj-demo"
        documents={[
          {
            file_name: 'Brandschutzkonzept_Wohnbau-Nord.pdf',
            snippet:
              'Der zweite Fluchtweg ist über das nördliche Treppenhaus sichergestellt; die Gehweglänge beträgt 34 m.',
            page: 12,
            score: 0.91,
            source: 'project',
          },
        ]}
      />

      {/* Several close project + Archiv matches. */}
      <DocumentAnswerCard
        title="Relevante Dokumente – Fluchtwege &amp; Brandschutz"
        query="Fluchtwege Brandschutz GK4"
        projectId="proj-demo"
        documents={[
          {
            file_name: 'Brandschutzkonzept_Wohnbau-Nord.pdf',
            snippet:
              'Der zweite Fluchtweg ist über das nördliche Treppenhaus sichergestellt; die Gehweglänge beträgt 34 m und liegt damit unter dem Grenzwert von 40 m gemäß OIB-Richtlinie 2.',
            page: 12,
            score: 0.91,
            source: 'project',
          },
          {
            file_name: 'Fluchtwegplan_EG-2OG.pdf',
            snippet: 'Fluchtwegführung für EG bis 2. OG mit Kennzeichnung der Notausgänge und Sammelstelle.',
            page: 2,
            score: 0.84,
            source: 'project',
          },
          {
            file_name: 'Referenzprojekt_Stadthaus-Wien.pdf',
            snippet: 'Vergleichbares Wohngebäude der Gebäudeklasse 4 mit innenliegendem Sicherheitstreppenhaus.',
            page: 5,
            score: 0.72,
            source: 'office',
          },
          {
            file_name: 'Detailkatalog_Treppen.pdf',
            snippet: 'Regeldetails für Treppenläufe, Steigungsverhältnisse und Geländerhöhen.',
            page: null,
            score: 0.63,
            source: 'office',
          },
          {
            file_name: 'Grundriss_Regelgeschoss.dwg',
            snippet: 'Regelgeschoss mit Wohnungstrennwänden und Erschließungskern.',
            page: null,
            score: 0.58,
            source: 'project',
          },
          {
            file_name: 'Fassadenschnitt_Nord.png',
            snippet: 'Nordfassade mit Fensteranordnung und Fluchtbalkon.',
            page: null,
            score: 0.51,
            source: 'project',
          },
          // Unresolvable (removed) file → lean "not available" fallback card.
          {
            file_name: 'Altes_Gutachten_2019.pdf',
            snippet: 'Historisches Brandschutzgutachten (nicht mehr im Projekt).',
            source: 'project',
          },
        ]}
      />

      {/* Compact example: a single strong hit. */}
      <DocumentAnswerCard
        title="Relevante Dokumente – Stellplatznachweis"
        query="Stellplätze Wohnbau"
        projectId="proj-demo"
        documents={[
          {
            file_name: 'Referenzprojekt_Stadthaus-Wien.pdf',
            snippet: 'Stellplatznachweis: 1 Kfz-Stellplatz je Wohneinheit, Fahrradabstellräume im UG.',
            page: 9,
            score: 0.79,
            source: 'office',
          },
        ]}
      />
    </main>
  )
}
