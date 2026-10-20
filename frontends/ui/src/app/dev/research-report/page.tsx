'use client'

/**
 * Dev preview for what a reader steers a deep research with, and what it hands
 * back: the Rechercheplan checklist (its „Unterlagen wählen" opens the picker),
 * and the report's
 * Befundmatrix in both of its forms — a table that judged (Befunde, with a
 * status per row) and one that only compared (Ergebnisse, no status column).
 *
 * The REAL components over fixtures; nothing is fetched. Not linked from
 * anywhere; 404s outside development. Pinned to German, the copy that ships.
 */

import { useState, type ReactNode } from 'react'
import { notFound } from 'next/navigation'

import { AgentResponse } from '@/features/chat/components/AgentResponse'
import { FindingsMatrix } from '@/features/chat/components/FindingsMatrix'
import { PlanChecklist, type PlanShape } from '@/features/chat/components/PlanChecklist'
import { I18nProvider } from '@/i18n'
import type { CitationSource } from '@/features/chat/types'
import type { Findings } from '@/lib/conversations/message-findings'
import type { PlanDocument } from '@/lib/runs/plan-documents'

const DOCUMENTS: PlanDocument[] = [
  { name: 'Einreichplan_EG.pdf', title: 'Einreichplan Erdgeschoß', shelf: 'project' },
  { name: 'Brandschutzkonzept_v3.pdf', title: 'Brandschutzkonzept, Stand 3', shelf: 'project' },
  { name: 'Baubeschreibung.docx', shelf: 'project' },
  { name: 'Stellungnahme_MA37_alt.pdf', title: 'Stellungnahme MA 37 (überholt)', shelf: 'project' },
  { name: 'Musterbrandschutzkonzept.pdf', shelf: 'archiv' },
]

const PLAN: PlanShape = {
  title: 'Brandschutz Wohnhausanlage Seestadt, Bauteil B',
  sections: [
    'Rechtsrahmen und Gebäudeklasse',
    'Fluchtwege',
    'Brandabschnitte',
    'Tragende Bauteile',
  ],
  genre: 'inspection_report',
  depth: 'quick_check',
  basis: ['Brandschutzkonzept_v3.pdf', 'Einreichplan_EG.pdf'],
  excluded: ['Stellungnahme_MA37_alt.pdf'],
  documents: DOCUMENTS,
}

const JUDGED: Findings = {
  v: 1,
  items: [
    {
      requirement: 'Feuerwiderstand tragender Bauteile',
      value: 'REI 60',
      status: 'met',
      grounding: 'sourced',
      reference: { document: 'OIB-Richtlinie 2', section: 'Tabelle 1b', page: 12 },
      citations: [1],
      comment: 'Gilt für GK 4; im Kellergeschoß REI 90.',
    },
    {
      requirement: 'Fluchtweglänge zum Treppenhaus',
      value: '38 m',
      status: 'not_met',
      grounding: 'sourced',
      reference: { document: 'OIB-Richtlinie 2', section: '5.1.1' },
      citations: [2],
      comment:
        'Zulässig sind 40 m ab der Wohnungseingangstür; gemessen wurde ab dem Aufenthaltsraum.',
    },
    { requirement: 'Zweiter Fluchtweg', status: 'open', grounding: 'open', citations: [] },
  ],
}

const COMPARED: Findings = {
  v: 1,
  items: [
    { requirement: 'Variante A — Außentreppe', value: '12 m', grounding: 'sourced', citations: [1] },
    {
      requirement: 'Variante B — zweites Treppenhaus',
      value: '15 m',
      grounding: 'sourced',
      citations: [2],
    },
  ],
}


const OIB = 'oib-rl_2_ausgabe_mai_2023.pdf'
const at = new Date('2026-07-28T14:30:00')

const REPORT_CITATIONS: CitationSource[] = [
  [12, 1, 'Tragende Bauteile müssen in Gebäuden der Gebäudeklasse 4 mindestens die Feuerwiderstandsklasse R 60 aufweisen.'],
  [18, 2, 'Die Länge des Fluchtweges darf von jeder Stelle eines Aufenthaltsraumes bis zu einem sicheren Ort des angrenzenden Bereiches ins Freie höchstens 40 m betragen.'],
  [24, 3, 'Brandabschnitte dürfen in Gebäuden der Gebäudeklassen 4 und 5 eine Netto-Grundfläche von 1.200 m² nicht überschreiten.'],
].map(([page, number, snippet]) => ({
  id: `oib-${page}`,
  content: `[KB] ${OIB}, p.${page}\n${snippet}`,
  citationKey: `${OIB}, p.${page}`,
  documentId: `doc:oib_knowledge:${OIB}`,
  fileName: OIB,
  collection: 'oib_knowledge',
  title: 'OIB-Richtlinie 2, Ausgabe Mai 2023',
  origin: 'kb' as const,
  kind: 'building_law' as const,
  lane: 'building_law_oib',
  laneLabel: 'OIB-Richtlinie',
  sourceType: 'knowledge_layer',
  page: Number(page),
  number: Number(number),
  isCited: true,
  timestamp: at,
}))

const REPORT = [
  'Die Wohnhausanlage Seestadt, Bauteil B, erfüllt die Brandschutzanforderungen der OIB-Richtlinie 2 bis auf zwei Punkte: Die Netto-Grundfläche des Brandabschnitts im 2. Obergeschoß überschreitet den Grenzwert, und für den Rauchabzug im Stiegenhaus liegt kein Nachweis vor [3].',
  '',
  '## Rechtsrahmen und Gebäudeklasse',
  'Das Gebäude ist nach den Angaben im Einreichplan der Gebäudeklasse 4 zuzuordnen. Für tragende Bauteile folgt daraus die Feuerwiderstandsklasse R 60, im Kellergeschoß aufgrund der Nutzung als Garage REI 90 [1]. Die Bauordnung für Wien macht die Richtlinie über die Vereinbarung gemäß Artikel 15a B-VG verbindlich.',
  '',
  '## Fluchtwege',
  'Die Fluchtweglänge zum Stiegenhaus beträgt nach dem Brandschutzkonzept 38 m, gemessen ab der Wohnungseingangstür. Zulässig sind 40 m von jeder Stelle eines Aufenthaltsraumes aus gemessen [2]; die Messung ab dem Aufenthaltsraum ist im Konzept nicht dokumentiert, sodass der Grenzwert rechnerisch nur dann eingehalten ist, wenn der Weg innerhalb der Wohnung höchstens 2 m beträgt.',
  '',
  '## Brandabschnitte',
  'Der Brandabschnitt im 2. Obergeschoß hat eine Netto-Grundfläche von 1.380 m² und überschreitet damit die zulässigen 1.200 m² [3]. Eine Teilung durch eine Brandwand in Achse C würde beide Hälften unter den Grenzwert bringen.',
  '',
  '## Tragende Bauteile',
  'Die Stahlbetonstützen und Decken sind im Brandschutzkonzept mit REI 90 ausgewiesen und liegen damit über der geforderten Klasse [1].',
  '',
  '## Rauchabzug',
  'Für das Stiegenhaus fehlt im Konzept eine Aussage zur Rauchableitung. Sie ist nachzureichen, bevor die Einreichung vollständig ist.',
  '',
  '## Nächste Schritte',
  '- Brandwand in Achse C im 2. Obergeschoß planen und im Brandschutzkonzept nachführen.',
  '- Rauchableitung des Stiegenhauses nachweisen.',
  '- Fluchtweglänge ab dem Aufenthaltsraum dokumentieren.',
  '',
  '## Quellen',
  `- [1] [KB] ${OIB}, p.12`,
  `- [2] [KB] ${OIB}, p.18`,
  `- [3] [KB] ${OIB}, p.24`,
].join('\n')

const Section = ({ label, children }: { label: string; children: ReactNode }) => (
  <section className="flex flex-col gap-3">
    <h2 className="text-muted-foreground text-xs font-semibold uppercase tracking-wide">{label}</h2>
    {children}
  </section>
)

export default function ResearchReportPreviewPage() {
  if (process.env.NODE_ENV !== 'development') {
    notFound()
  }
  const [plan, setPlan] = useState<PlanShape>(PLAN)

  return (
    <I18nProvider initialLocale="de" fixedLocale>
      <main
        data-testid="research-report-preview"
        className="text-foreground mx-auto flex w-full max-w-3xl flex-col gap-8 p-6 md:p-8"
      >
        <header>
          <h1 className="text-xl font-semibold tracking-tight">
            Tiefenrecherche: Plan, Unterlagen, Befunde
          </h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Was die Leserin vor dem Lauf festlegt, und was der Bericht zurückgibt.
          </p>
        </header>

        <Section label="Rechercheplan — Abschnitte, Genre, Tiefe, Unterlagen">
          <PlanChecklist plan={plan} onChange={setPlan} />
        </Section>

        <Section label="Befundmatrix — ein Bericht, der prüft">
          <FindingsMatrix findings={JUDGED} anchorPrefix="src-" />
        </Section>

        <Section label="Ein langer Bericht — Abschnitte, Matrix und Quellen">
          <AgentResponse
            content={REPORT}
            messageId="report-1"
            citations={REPORT_CITATIONS}
            routingDecision="deep"
            findings={JUDGED}
          />
        </Section>

        <Section label="Ergebnisse — ein Vergleich ohne Urteil">
          <FindingsMatrix findings={COMPARED} anchorPrefix="src-" />
        </Section>
      </main>
    </I18nProvider>
  )
}
