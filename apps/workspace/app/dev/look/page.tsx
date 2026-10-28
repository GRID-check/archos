'use client'

/**
 * Dev preview: where Piloti looked (ADR-0128), as the reader of a chat sees it.
 *
 *   1. The look card under an answer: two looks at an A1 Grundriss (the
 *      Plankopf, a room) with what Piloti read there, and the box it showed
 *      the room. Each place is the page clip with the box marked; pressing
 *      one opens the sheet at the page with the box glowing.
 *   2. The same card for a document the reader may not open: the place in
 *      words, no picture.
 *   3. The Herleitung of that turn: the retrieval round that found the sheet
 *      and, under the graph, one row for the three looks at it.
 *
 * Backend-free: a module-scope fetch shim answers the sheet's `/file` with the
 * A1 fixture (`../_fixtures/a1-sheet.ts`) and the hidden document's with 404,
 * as `getAccessibleDocument` answers a reader who may not open it. Fixtures:
 * `../_fixtures/look.ts`. Gated by `../layout.tsx`. Pinned to German.
 */

import { useMemo, type FC } from 'react'
import { I18nProvider } from '@/i18n'
import { parseWireEvent } from '@/adapters/api/wire-v2'
import { ReasoningFlow } from '@/features/chat/components/reasoning/ReasoningFlow'
import { foldTurnEvents } from '@/features/chat/lib/turn-fold'
import { LookCard } from '@/features/cards/components/LookCard'
import { a1SheetPdf } from '../_fixtures/a1-sheet'
import { LOOK_CARD, LOOK_CARD_NO_ACCESS, LOOK_HIDDEN_ID, LOOK_SHEET_ID, LOOK_STEP_BODIES } from '../_fixtures/look'

if (typeof window !== 'undefined' && process.env.NODE_ENV === 'development') {
  const w = window as unknown as { __lookPreviewShim?: boolean }
  if (!w.__lookPreviewShim) {
    w.__lookPreviewShim = true
    const real = window.fetch.bind(window)
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.endsWith(`/api/documents/${LOOK_SHEET_ID}/file`)) {
        return new Response(a1SheetPdf('C'), { headers: { 'Content-Type': 'application/pdf' } })
      }
      if (url.includes(`/api/documents/${LOOK_HIDDEN_ID}/`)) {
        return Response.json({ code: 'NOT_FOUND' }, { status: 404 })
      }
      return real(input, init)
    }
  }
}

/** The steps as the app stores them: wire events folded by the turn fold. */
const useSteps = () =>
  useMemo(() => {
    const events = LOOK_STEP_BODIES.flatMap((body, index) => {
      const event = parseWireEvent({
        v: 2,
        conversation_id: 'conv-look',
        turn_id: 'turn-look',
        seq: index + 1,
        ts: 1_790_000_000_000 + index * 10,
        ...body,
      })
      return event ? [event] : []
    })
    const view = foldTurnEvents(undefined, events)
    return view ? view.stepOrder.map((id) => view.steps[id]) : []
  }, [])

const Scenario: FC<{ id: string; title: string; note: string; children: React.ReactNode }> = ({
  id,
  title,
  note,
  children,
}) => (
  <section data-testid={`look-scenario-${id}`} className="flex flex-col gap-3">
    <div>
      <h2 className="text-foreground text-sm font-semibold">{title}</h2>
      <p className="text-muted-foreground text-xs">{note}</p>
    </div>
    {children}
  </section>
)

const Preview: FC = () => {
  const steps = useSteps()
  return (
    <main data-testid="look-preview" className="text-foreground mx-auto flex w-full max-w-[720px] flex-col gap-10 p-4 sm:p-6">
      <Scenario id="card" title="Angesehen-Karte" note="Zwei Ansichten mit dem Gelesenen und eine gezeigte Stelle, auf einem A1-Grundriss.">
        <LookCard document={LOOK_CARD.document} items={LOOK_CARD.items} />
      </Scenario>
      <Scenario id="no-access" title="Ohne Zugriff" note="Ein Dokument, das die lesende Person nicht öffnen darf: die Stelle in Worten, kein Bild.">
        <LookCard document={LOOK_CARD_NO_ACCESS.document} items={LOOK_CARD_NO_ACCESS.items} />
      </Scenario>
      <Scenario id="herleitung" title="Herleitung" note="Die Suchrunde, die das Blatt fand, und darunter eine Zeile für drei Ansichten desselben Blatts.">
        <div className="border-base rounded-lg border px-2 pb-3 pt-3 sm:px-4">
          <ReasoningFlow
            steps={steps}
            userQuestion="Welcher Index und welche Fläche hat Top 1 im Grundriss 1. OG?"
            answerConfidence="medium"
          />
        </div>
      </Scenario>
    </main>
  )
}

export default function LookPreviewPage() {
  return (
    <I18nProvider initialLocale="de" fixedLocale>
      <Preview />
    </I18nProvider>
  )
}
