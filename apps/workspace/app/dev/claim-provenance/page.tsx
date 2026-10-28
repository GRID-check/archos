'use client'

/**
 * Dev preview: the confidence of an answer, as the answer check gives it (ADR-0139).
 *
 *   1. A CHECKED ANSWER through the real `AgentResponse`, and the chip on its
 *      own beside it, so its tooltip can be hovered without opening the
 *      details: the level, the statements the check found unbacked or
 *      contradicted, and the source each was checked against.
 *   2. A CHECK THAT COULD NOT RUN: no level, „Belegprüfung nicht verfügbar".
 *   3. A SEARCH THAT FOUND NOTHING: the answer shows, with the note under it,
 *      and the label „[Beleg nicht verifiziert]" where it cited anyway.
 *   4. A STORED ANSWER from before the check: its own level and copy.
 *
 * 404s outside development. Pinned to German.
 */

import { notFound } from 'next/navigation'
import type { FC, ReactNode } from 'react'
import { I18nProvider } from '@/i18n'
import { AgentResponse } from '@/features/chat/components/AgentResponse'
import { ConfidenceChip } from '@/features/chat/components/ConfidenceChip'
import type { ConfidenceCheck } from '@/lib/conversations/confidence-check'

const at = new Date('2026-10-27T09:30:00')

const CHECKED: ConfidenceCheck = {
  status: 'judged',
  level: 'low',
  findings: [
    {
      statement: 'Die Treppe ist 1,50 m breit',
      problem: 'contradicted',
      reason: 'Der Schnitt nennt 1,10 m Laufbreite.',
      source: '[1] Schnitt A-A.pdf, S. 2',
    },
    {
      statement: 'Ein zweiter Fluchtweg ist erforderlich',
      problem: 'unbacked',
      reason: 'Keine abgerufene Stelle sagt das.',
      source: 'none',
    },
  ],
}

const Block: FC<{ title: string; note: string; children: ReactNode }> = ({ title, note, children }) => (
  <section className="flex flex-col gap-3">
    <div>
      <h2 className="text-foreground text-sm font-semibold">{title}</h2>
      <p className="text-muted-foreground text-xs">{note}</p>
    </div>
    {children}
  </section>
)

function Preview() {
  return (
    <main
      data-testid="claim-provenance-preview"
      className="text-foreground mx-auto flex w-full max-w-[760px] flex-col gap-10 p-4 sm:p-6"
    >
      <Block
        title="Geprüfte Antwort"
        note="Ein Prüfmodell hat die Antwort gegen alles gelesen, was sie abgerufen hat; der Tooltip nennt, was nicht belegt ist."
      >
        <ConfidenceChip confidence="low" version={2} check={CHECKED} />
        <AgentResponse
          content="Die Treppe ist 1,50 m breit [1]. Ein zweiter Fluchtweg ist erforderlich."
          messageId="check-judged"
          timestamp={at}
          answerConfidence="low"
          answerConfidenceVersion={2}
          confidenceCheck={CHECKED}
        />
      </Block>
      <Block
        title="Belegprüfung nicht verfügbar"
        note="Das Prüfmodell lief nicht (kein Modell, Zeitüberschreitung, Fehler): keine Einschätzung, und der Chip sagt es."
      >
        <ConfidenceChip confidence={null} check={{ status: 'unavailable', findings: [] }} />
      </Block>
      <Block
        title="Die Suche fand nichts"
        note="Die Antwort steht da, mit dem Hinweis darunter; wo sie trotzdem zitiert, steht „[Beleg nicht verifiziert]“."
      >
        <AgentResponse
          content="Hochhäuser regelt die OIB-Richtlinie 2.3 [Beleg nicht verifiziert]. Ab 22 m Fluchtniveau gelten zusätzliche Anforderungen."
          messageId="check-nothing-found"
          timestamp={at}
          routingDecision="shallow"
          answerConfidence="low"
          answerConfidenceVersion={2}
          confidenceCheck={{ status: 'judged', level: 'low', findings: [] }}
          lookupFoundNothing
        />
      </Block>
      <Block
        title="Gespeicherte Antwort von vorher"
        note="Ohne Prüfung: die Stufe und die Texte der Regel, unter der sie gespeichert wurde."
      >
        <ConfidenceChip confidence="low" cappedReason="ungrounded" />
      </Block>
    </main>
  )
}

export default function ClaimProvenancePreviewPage() {
  if (process.env.NODE_ENV !== 'development') {
    notFound()
  }
  return (
    <I18nProvider initialLocale="de" fixedLocale>
      <Preview />
    </I18nProvider>
  )
}
