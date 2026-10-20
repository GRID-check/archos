'use client'

/**
 * Dev preview for the visual Fassung comparison.
 *
 * Pages are drawn in code (a floor outline with one partition moved, a door
 * turned and a window added), so nothing is fetched and no image is committed.
 * Four stories, one button each, because the states differ in what they ask of
 * the layout rather than in what they look like when they work:
 *
 *  1. **Gleiche Seitenzahl.** The ordinary case, with five sample changes
 *     marked and listed. Judge the three modes on it: in Überlagert the
 *     unchanged walls should go near-black and only the moved partition,
 *     door and window keep a colour; in Wischen the divider should be easy to
 *     find and to grab.
 *     „Gleiche Seitenzahl“ starts unmarked: „Änderungen von Piloti markieren“
 *     asks a stubbed route (no model call) and draws its boxes and sentences.
 *     „Bekannte Änderungen“ opens with the boxes already drawn.
 *  2. **Unterschiedliche Seitenzahl.** One revision has fewer sheets; the note
 *     says so and the shorter side says which page it lacks.
 *  3. **Nicht vergleichbar.** A spreadsheet: the state must point at the text
 *     comparison instead of showing an empty frame.
 *  4. **Ladefehler.** The loader rejects; „Erneut versuchen" must be offered.
 *  5. **Lange Dateinamen.** Two names that differ only in their index near the
 *     end: the header, the captions and the swipe tags must keep that end.
 *  6. **Piloti nicht erreichbar.** The marking route answers 503; the dialog
 *     presses the button itself, so the refusal and its retry are on screen.
 *  7. **Zwei Seiten markiert.** The dialog marks page 1, turns to page 2 and
 *     marks it too: both pages' changes must stay listed, grouped by page,
 *     and page 1's boxes must still be there when you turn back.
 *
 * Pinned to German (`fixedLocale`). 404s outside development.
 */

import type { JSX } from 'react'
import { useEffect, useState } from 'react'
import { notFound } from 'next/navigation'
import { I18nProvider } from '@/i18n'
import { Button } from '@/components/ui/button'
import { useRevisionCompare } from '@/features/documents/components/revision-compare'
import {
  FIXTURE_OVERLAYS,
  fixtureLoader,
} from '@/features/documents/components/revision-compare/fixture-sheets'

type Autoplay = 'mark' | 'mark-two'

interface Story {
  id: string
  label: string
  older: { id: string; filename: string }
  newer: { id: string; filename: string }
  overlays: typeof FIXTURE_OVERLAYS | readonly []
  autoplay?: Autoplay
}

const STORIES: readonly Story[] = [
  {
    id: 'same',
    label: 'Gleiche Seitenzahl',
    older: { id: 'older', filename: 'Grundriss_1OG_B.pdf' },
    newer: { id: 'newer', filename: 'Grundriss_1OG_C.pdf' },
    overlays: [],
  },
  {
    id: 'known',
    label: 'Bekannte Änderungen',
    older: { id: 'older', filename: 'Grundriss_1OG_B.pdf' },
    newer: { id: 'newer', filename: 'Grundriss_1OG_C.pdf' },
    overlays: FIXTURE_OVERLAYS,
  },
  {
    id: 'pages',
    label: 'Unterschiedliche Seitenzahl',
    older: { id: 'older', filename: 'Grundriss_1OG_B-kurz.pdf' },
    newer: { id: 'newer', filename: 'Grundriss_1OG_C-mehr.pdf' },
    overlays: [],
  },
  {
    id: 'office',
    label: 'Nicht vergleichbar',
    older: { id: 'older', filename: 'Kostenaufstellung_B.xlsx' },
    newer: { id: 'newer', filename: 'Kostenaufstellung_C.xlsx' },
    overlays: [],
  },
  {
    id: 'failed',
    label: 'Ladefehler',
    older: { id: 'older', filename: 'fail_B.pdf' },
    newer: { id: 'newer', filename: 'Grundriss_1OG_C.pdf' },
    overlays: [],
  },
  {
    id: 'long',
    label: 'Lange Dateinamen',
    older: { id: 'older', filename: 'Wohnanlage-Schlosspark_Haus-B_Grundriss_1OG_Index_B_2026-09-14.pdf' },
    newer: { id: 'newer', filename: 'Wohnanlage-Schlosspark_Haus-B_Grundriss_1OG_Index_C_2026-10-02.pdf' },
    overlays: FIXTURE_OVERLAYS,
  },
  {
    id: 'error',
    label: 'Piloti nicht erreichbar',
    older: { id: 'older', filename: 'Grundriss_1OG_B.pdf' },
    newer: { id: 'newer-503', filename: 'Grundriss_1OG_C.pdf' },
    overlays: [],
    autoplay: 'mark',
  },
  {
    id: 'marked-two',
    label: 'Zwei Seiten markiert',
    older: { id: 'older', filename: 'Grundriss_1OG_B.pdf' },
    newer: { id: 'newer', filename: 'Grundriss_1OG_C.pdf' },
    overlays: [],
    autoplay: 'mark-two',
  },
]

const SUMMARIES: Record<number, string[]> = {
  1: [
    'Die Trennwand zwischen Büro 1 und Besprechung ist um etwa 60 cm nach rechts versetzt.',
    'Der Türanschlag im Flur ist gedreht.',
    'Im Norden ist ein drittes Fenster dazugekommen.',
  ],
  2: ['Die Treppe hat eine Steigung mehr, neun statt acht.'],
}

/**
 * Answer the change-marking route from the fixture, so the preview needs no
 * backend and spends no model call. Everything else goes to the real `fetch`.
 */
function useStubbedChangeRoute(): void {
  useEffect(() => {
    const real = window.fetch
    window.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (!url.endsWith('/fassung-compare')) return real(input, init)
      await new Promise((resolve) => setTimeout(resolve, 900))
      if (url.includes('/newer-503/')) return new Response(null, { status: 503 })
      const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : {}
      const page = typeof body === 'object' && body !== null && 'page' in body ? Number(body.page) : 1
      return Response.json({
        regions: FIXTURE_OVERLAYS.filter((region) => region.page === page),
        summary: SUMMARIES[page] ?? [],
      })
    }
    return () => {
      window.fetch = real
    }
  }, [])
}

/** The text comparison lives in the Fassung history; here it only says it was asked for. */
const COMPARE_OPTIONS = {
  onOpenTextCompare: (older: { filename: string }, newer: { filename: string }) =>
    window.alert(`Textvergleich: ${older.filename} ↔ ${newer.filename}`),
}

/** Wait for `selector` to match an enabled element, then return it; null after ~8 s. */
async function enabled(selector: string): Promise<HTMLElement | null> {
  for (let tries = 0; tries < 80; tries += 1) {
    const node = document.querySelector<HTMLElement>(selector)
    if (node && !node.hasAttribute('disabled') && node.getAttribute('aria-disabled') !== 'true') return node
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return null
}

/**
 * Press the buttons a reader would, so a state that needs a run is on screen
 * without anyone clicking: the refusal, or two marked pages.
 */
function useAutoplay(autoplay: Autoplay | undefined, run: number): void {
  useEffect(() => {
    if (!autoplay || run === 0) return
    let stopped = false
    void (async () => {
      const mark = await enabled('[data-testid="compare-mark"]')
      if (stopped || !mark) return
      mark.click()
      if (autoplay !== 'mark-two') return
      await enabled('[data-testid="compare-change"]')
      const next = await enabled('[aria-label="Nächste Seite"]')
      if (stopped || !next) return
      next.click()
      const second = await enabled('[data-testid="compare-mark"]')
      if (!stopped) second?.click()
    })()
    return () => {
      stopped = true
    }
  }, [autoplay, run])
}

function Preview(): JSX.Element {
  useStubbedChangeRoute()
  const { openRevisionCompare, compareElement } = useRevisionCompare(fixtureLoader, COMPARE_OPTIONS)
  const [played, setPlayed] = useState<{ autoplay?: Autoplay; run: number }>({ run: 0 })
  useAutoplay(played.autoplay, played.run)
  return (
    <main className="bg-background mx-auto max-w-3xl space-y-4 p-6" data-testid="revision-compare-preview">
      <h1 className="text-foreground text-base font-medium">Fassungen vergleichen</h1>
      <p className="text-muted-foreground text-sm">
        Tasten im geöffneten Vergleich: ← → blättern, Pos1 und Ende springen, 1 2 3 wechseln die Ansicht, Esc
        schließt. Strg + Mausrad zoomt, Ziehen verschiebt.
      </p>
      <div className="flex flex-wrap gap-2">
        {STORIES.map((story) => (
          <Button
            key={story.id}
            variant="outline"
            data-testid={`open-${story.id}`}
            onClick={() => {
              openRevisionCompare(story.older, story.newer, story.overlays)
              setPlayed((last) => ({ autoplay: story.autoplay, run: last.run + 1 }))
            }}
          >
            {story.label}
          </Button>
        ))}
      </div>
      {compareElement}
    </main>
  )
}

export default function RevisionCompareDevPage(): JSX.Element {
  if (process.env.NODE_ENV !== 'development') {
    notFound()
  }
  return (
    <I18nProvider initialLocale="de" fixedLocale>
      <Preview />
    </I18nProvider>
  )
}
