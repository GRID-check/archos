'use client'

/**
 * Dev preview — „Als Skizze bearbeiten": a drawing Piloti made, reworked by hand.
 *
 * Two panels:
 *
 *  1. **A flow.** The Einreichung's path, drawn by Piloti's own view, with
 *     „Als Skizze bearbeiten" beside „Im Projekt ablegen". Pressing it loads
 *     the Excalidraw canvas (only then, ADR-0141) on Piloti's drawing, laid out
 *     the way the view laid it out.
 *  2. **A Gliederung.** A mindmap opens as a tree of boxes, left to right.
 *
 * `?open=1` opens the first panel's editor on load, for a capture.
 *
 * Filing goes to `/api/projects/proj-preview/diagrams`, which the preview has
 * no session for: the refusal is shown in the dialog, as any refusal is.
 * Pinned to German. 404s outside development.
 */

import { notFound, useSearchParams } from 'next/navigation'
import { Suspense, useEffect } from 'react'
import { I18nProvider } from '@/i18n'
import { MarkdownRenderer } from '@/shared/components/MarkdownRenderer'
import { DiagramFilingProvider } from '@/features/diagrams/diagram-filing-context'
import { PRODUCT_NAME } from '@/lib/brand'

const FLOW = `\`\`\`mermaid
graph TD
  A["Einreichung"] --> B["Bauverhandlung"]
  B --> C{"Auflagen?"}
  C -- "ja" --> D["Auflagen erfüllen"]
  C -- "nein" --> E["Baubewilligung"]
  D --> E
  E --> F["Fertigstellungsanzeige"]
\`\`\``

const MAP = `\`\`\`mermaid
mindmap
  root((OIB-Richtlinie 2))
    Brandabschnitte
    Fluchtwege
      Fluchtweglänge
      Treppenhäuser
    Löschwasser
\`\`\``

function Panel({ title, note, children }: { title: string; note: string; children: React.ReactNode }) {
  return (
    <section className="flex w-[680px] max-w-full flex-col gap-2">
      <h2 className="text-foreground text-sm font-semibold">{title}</h2>
      <p className="text-muted-foreground text-xs">{note}</p>
      <div className="border-input bg-card rounded-lg border px-[22px] pt-[18px] pb-[17px]">{children}</div>
    </section>
  )
}

/**
 * `?open=1` presses the first „Als Skizze bearbeiten" once it is drawn.
 * `?filed=1` answers the preview's filing with the route's 201, so the filed
 * state can be looked at without a session.
 */
function OpenOnLoad() {
  const params = useSearchParams()
  useEffect(() => {
    if (params.get('filed') !== '1') return
    const original = window.fetch
    window.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (!url.endsWith('/api/projects/proj-preview/diagrams')) return original(input, init)
      return new Response(JSON.stringify({ svg: { documentId: 'doc-svg' }, pdf: { documentId: 'doc-pdf' } }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    return () => {
      window.fetch = original
    }
  }, [params])
  useEffect(() => {
    if (params.get('open') !== '1') return
    const timer = window.setInterval(() => {
      const button = document.querySelector<HTMLButtonElement>('[data-testid="diagram-edit-sketch"]')
      if (!button) return
      window.clearInterval(timer)
      button.click()
    }, 200)
    return () => window.clearInterval(timer)
  }, [params])
  return null
}

export default function DiagramSketchPreview() {
  if (process.env.NODE_ENV !== 'development') notFound()

  return (
    <I18nProvider initialLocale="de" fixedLocale>
      <Suspense>
        <OpenOnLoad />
      </Suspense>
      <div data-testid="diagram-sketch-preview" className="bg-background flex min-h-screen flex-col items-center gap-10 p-4 sm:p-10">
        <Panel
          title="Ablauf, als Skizze bearbeitbar"
          note={"„Als Skizze bearbeiten“ öffnet die Zeichenfläche erst auf Klick, mit " + PRODUCT_NAME + "s Zeichnung als Ausgangspunkt. Abgelegt wird über denselben Weg wie jedes Diagramm, mit dem Vermerk „Von " + PRODUCT_NAME + " entworfen, von einer Person bearbeitet“."}
        >
          <DiagramFilingProvider target={{ projectId: 'proj-preview', answerId: 'msg-preview' }}>
            <MarkdownRenderer content={FLOW} />
          </DiagramFilingProvider>
        </Panel>
        <Panel
          title="Gliederung"
          note="Eine Gliederung öffnet als Baum von links nach rechts. Übergaben, Zeitpläne und Anteile haben keine Skizze: sie sind keine Knotengraphen."
        >
          <DiagramFilingProvider target={{ projectId: 'proj-preview', answerId: 'msg-preview-map' }}>
            <MarkdownRenderer content={MAP} />
          </DiagramFilingProvider>
        </Panel>
      </div>
    </I18nProvider>
  )
}
