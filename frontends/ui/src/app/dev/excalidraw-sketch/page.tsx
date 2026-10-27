'use client'

/**
 * Dev preview — sketches Piloti drew in Excalidraw's own format (ADR-0146).
 *
 * Every sketch below is an answer dev Piloti's model wrote on 2026-10-27
 * (`_fixtures/model-sketches.ts`, verbatim), rendered by the real Markdown
 * renderer inside a filing target, as an answer in a project is: a room-bubble
 * sketch, a site sketch, an annotated flow, a document wireframe and a
 * comparison board. Then the two other states: a fence the server refused
 * (`excalidraw-refused`, one quiet line, never the JSON) and one still being written,
 * replayed element by element (`?stream=0` holds it half-written for a
 * capture).
 *
 * `?theme=dark` puts the page in dark mode. Filing goes to
 * `/api/projects/proj-preview/diagrams`, which the preview has no session for.
 * Pinned to German. 404s outside development.
 */

import { notFound, useSearchParams } from 'next/navigation'
import { Suspense, useEffect, useState } from 'react'
import { I18nProvider } from '@/i18n'
import { MarkdownRenderer } from '@/shared/components/MarkdownRenderer'
import { DiagramFilingProvider } from '@/features/diagrams/diagram-filing-context'
import { MODEL_SKETCHES } from '../_fixtures/model-sketches'

const REFUSED = [
  'Eine erste Skizze der Zonen:',
  '',
  '```excalidraw-refused',
  '{"elements": [{"type": "image", "x": 0, "y": 0, "fileId": "grundriss"}]}',
  '```',
].join('\n')

function Panel({ title, note, children }: { title: string; note: string; children: React.ReactNode }) {
  return (
    <section className="flex w-[760px] max-w-full flex-col gap-2" data-testid="sketch-panel">
      <h2 className="text-sm font-semibold text-foreground">{title}</h2>
      <p className="text-xs text-muted-foreground">{note}</p>
      <div className="rounded-lg border border-input bg-card px-[22px] pb-[17px] pt-[18px]">{children}</div>
    </section>
  )
}

/** The room sketch's answer replayed a few characters at a time, as the stream delivers it. */
function Streaming({ answer, hold }: { answer: string; hold: boolean }) {
  const [length, setLength] = useState(hold ? Math.floor(answer.length * 0.55) : 0)
  useEffect(() => {
    if (hold || length >= answer.length) return
    const timer = setTimeout(() => setLength((at) => Math.min(answer.length, at + 60)), 30)
    return () => clearTimeout(timer)
  }, [answer.length, hold, length])
  return <MarkdownRenderer content={answer.slice(0, length)} isStreaming={length < answer.length} />
}

function Preview() {
  const params = useSearchParams()
  const dark = params.get('theme') === 'dark'
  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark)
  }, [dark])
  const only = params.get('only')
  const sketches = only ? MODEL_SKETCHES.filter((sketch) => sketch.name === only) : MODEL_SKETCHES

  return (
    <div data-testid="excalidraw-sketch-preview" className="flex min-h-screen flex-col items-center gap-10 bg-background p-10">
      {sketches.map((sketch) => (
        <Panel key={sketch.name} title={sketch.title} note={`Gefragt: „${sketch.question}“`}>
          <DiagramFilingProvider target={{ projectId: 'proj-preview', answerId: `msg-${sketch.name}` }}>
            <MarkdownRenderer content={sketch.answer} />
          </DiagramFilingProvider>
        </Panel>
      ))}
      {only ? null : (
        <>
          <Panel
            title="Vom Server abgelehnt"
            note="Ein Bild-Element ist in einer Skizze nicht erlaubt. Der Server hat den Block als excalidraw-refused gespeichert; die Leserin sieht eine leise Zeile, nie den Quelltext."
          >
            <MarkdownRenderer content={REFUSED} />
          </Panel>
          <Panel
            title="Noch im Fluss"
            note="Die Raum-Skizze, Zeichen für Zeichen wieder abgespielt: jedes Element erscheint, sobald es ganz angekommen ist."
          >
            <Streaming answer={MODEL_SKETCHES[0].answer} hold={params.get('stream') === '0'} />
          </Panel>
        </>
      )}
    </div>
  )
}

export default function ExcalidrawSketchPreview() {
  if (process.env.NODE_ENV !== 'development') notFound()
  return (
    <I18nProvider initialLocale="de" fixedLocale>
      <Suspense>
        <Preview />
      </Suspense>
    </I18nProvider>
  )
}
