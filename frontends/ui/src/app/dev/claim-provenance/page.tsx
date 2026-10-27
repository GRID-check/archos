'use client'

/**
 * Dev preview: what an answer rests on, sentence by sentence (ADR-0125, ADR-0139).
 *
 * Four answers through the real `AgentResponse`, and the confidence chip on its
 * own beside each, so its tooltip can be hovered without opening the details:
 *
 *   1. A WORKSPACE ANSWER read from records: the chip leads with
 *      „1 von 1 Aussagen belegt", muted.
 *   1b. AN ANSWER FROM FILES IT READ, with one next step the normative net
 *      catches: „3 von 4 Aussagen belegt · Rechtsaussage ohne Beleg". Rule 2
 *      showed „niedrig" (the bug ADR-0139 fixes).
 *   2. A MIXED ANSWER: a record and a cited passage, and a statement about the
 *      law with no source beside them. „niedrig", and the tooltip says which.
 *   3. A SEARCH THAT FOUND NOTHING: the answer shows, with the note under it,
 *      and the label „[Beleg nicht verifiziert]" where it cited anyway.
 *   4. STORED ANSWERS from before: rule 2 keeps its level and its copy; no
 *      version keeps the answer-level copy.
 *
 * 404s outside development. Pinned to German.
 */

import { notFound } from 'next/navigation'
import type { FC, ReactNode } from 'react'
import { I18nProvider } from '@/i18n'
import { AgentResponse } from '@/features/chat/components/AgentResponse'
import { ConfidenceChip } from '@/features/chat/components/ConfidenceChip'
import type { ClaimStamp } from '@/lib/conversations/message-claim-stamps'

const at = new Date('2026-10-21T09:30:00')

const WORKSPACE: ClaimStamp[] = [
  {
    text: 'Anna Berger hat drei Freigaben, davon 2 offen: Einreichplan EG und Schnitt A-A.',
    provenance: 'record',
    claimType: 'value',
    loadBearing: true,
    support: 1,
    operation: 'project-approvals-list',
  },
  {
    text: 'Der Lageplan ist freigegeben.',
    provenance: 'record',
    claimType: 'descriptive',
    loadBearing: false,
    support: 1,
    operation: 'project-approvals-list',
  },
]

const MIXED: ClaimStamp[] = [
  {
    text: 'Anna Berger hat drei Freigaben.',
    provenance: 'record',
    claimType: 'value',
    loadBearing: true,
    support: 1,
    operation: 'project-approvals-list',
  },
  {
    text: 'Aufenthaltsräume müssen mindestens 2,50 m hoch sein [1].',
    provenance: 'cited',
    claimType: 'normative',
    loadBearing: true,
    support: 1,
  },
  {
    text: 'Das betrifft auch das Dachgeschoß.',
    provenance: 'reasoning',
    claimType: 'descriptive',
    loadBearing: false,
    support: 0.5,
  },
  {
    text: 'Der Einreichplan muss nach § 5 bewilligt werden.',
    provenance: 'model_knowledge',
    claimType: 'normative',
    loadBearing: true,
    support: 0,
  },
]

const NOTHING_FOUND: ClaimStamp[] = [
  {
    text: 'Hochhäuser regelt die OIB-Richtlinie 2.3 [Beleg nicht verifiziert].',
    provenance: 'cited_dropped',
    claimType: 'normative',
    loadBearing: true,
    support: 0,
  },
  {
    text: 'Ab 22 m Fluchtniveau gelten zusätzliche Anforderungen.',
    provenance: 'model_knowledge',
    claimType: 'normative',
    loadBearing: true,
    support: 0,
  },
]

const FILES_READ: ClaimStamp[] = [
  {
    text: 'Der Fluchtweg führt über das Treppenhaus T1 ins Freie [1].',
    provenance: 'cited',
    claimType: 'normative',
    loadBearing: true,
    support: 1,
  },
  {
    text: 'Eine Sprinkleranlage ist nicht vorgesehen [2].',
    provenance: 'cited',
    claimType: 'descriptive',
    loadBearing: false,
    support: 1,
  },
  {
    text: 'Für die Einreichung sind 2 Pläne vorhanden [1].',
    provenance: 'cited',
    claimType: 'value',
    loadBearing: true,
    support: 1,
  },
  {
    text: 'Die Brandmeldeanlage deckt alle 4 Geschoße ab [2].',
    provenance: 'cited',
    claimType: 'value',
    loadBearing: true,
    support: 1,
  },
  {
    text: 'Welche Brandabschnitte die Pläne zeigen, muss im Einzelnen geöffnet werden.',
    provenance: 'model_knowledge',
    claimType: 'normative',
    loadBearing: true,
    support: 0,
  },
]

const Block: FC<{ title: string; note: string; children: ReactNode }> = ({
  title,
  note,
  children,
}) => (
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
        title="Antwort aus dem Arbeitsbereich"
        note="Zwei Sätze, beide aus gelesenen Einträgen: „1 von 1 Aussagen belegt“, ruhig."
      >
        <ConfidenceChip confidence="high" version={2} claimStamps={WORKSPACE} />
        <AgentResponse
          content={WORKSPACE.map((stamp) => stamp.text).join(' ')}
          messageId="claims-workspace"
          timestamp={at}
          answerConfidence="high"
          answerConfidenceVersion={2}
          claimStamps={WORKSPACE}
        />
      </Block>
      <Block
        title="Aus gelesenen Dateien, mit einem nächsten Schritt"
        note="Vier Aussagen zitiert, ein nächster Schritt fängt sich im Rechtsnetz: „3 von 4 Aussagen belegt · Rechtsaussage ohne Beleg“. Unter Regel 2 stand hier „niedrig“."
      >
        <ConfidenceChip
          confidence="medium"
          cappedReason="normative_claim_uncited"
          version={2}
          claimStamps={FILES_READ}
        />
      </Block>
      <Block
        title="Gemischte Antwort"
        note="Ein Eintrag und eine zitierte Stelle, daneben eine Rechtsaussage ohne Quelle: die Zählung, die benannte Grenze, und der Tooltip sagt warum."
      >
        <ConfidenceChip
          confidence="medium"
          cappedReason="normative_claim_uncited"
          version={2}
          claimStamps={MIXED}
        />
      </Block>
      <Block
        title="Die Suche fand nichts"
        note="Die Antwort steht da, mit dem Hinweis darunter; wo sie trotzdem zitiert, steht „[Beleg nicht verifiziert]“."
      >
        <AgentResponse
          content={NOTHING_FOUND.map((stamp) => stamp.text).join(' ')}
          messageId="claims-nothing-found"
          timestamp={at}
          routingDecision="shallow"
          answerConfidence="low"
          answerConfidenceCappedReason="ungrounded"
          answerConfidenceVersion={2}
          claimStamps={NOTHING_FOUND}
          lookupFoundNothing
        />
      </Block>
      <Block
        title="Gespeicherte Antwort von vorher"
        note="Regel 2 (gespeichert vor ADR-0139): die Stufe, mit der Aufschlüsselung im Tooltip. Ohne Version: die Texte der alten Regel, keine Aufschlüsselung."
      >
        <ConfidenceChip
          confidence="low"
          cappedReason="normative_claim_uncited"
          version={2}
          claimStamps={MIXED}
        />
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
