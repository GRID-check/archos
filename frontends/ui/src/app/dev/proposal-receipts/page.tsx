'use client'

/**
 * Dev preview — the proposal cards as receipts of a proposal the server holds
 * (ADR-0105): files, a memory note, a change to the project facts, and an
 * action of the agent catalog (ADR-0121), whose long value „Übernehmen“ waits on.
 *
 * `/dev` has no backend, so the proposals API is faked
 * (`../_fixtures/fake-proposals.ts`) with the real response shape: pressing
 * „Übernehmen“ or „Verwerfen“ moves the proposal as the server would, and the
 * card shows who decided it and when. Per kind, judge:
 *
 *  - **Open**: the question reads before the buttons; „Übernehmen?“ wraps onto
 *    its own line on a phone rather than sitting under the primary button.
 *  - **Decided by a colleague**: „Übernommen von Anna · 14:02“, results per
 *    row for files (one failed, with its reason), the change as made for the
 *    project facts (no „vorher“ once it holds).
 *  - **Read only**: no buttons, and the line that says why.
 *  - Memory: the kind and confidence, where the note goes, „Ersetzt: …“ for a
 *    correction, and „Nur im Projekt merken“ beside „Übernehmen“.
 *  - Project facts: before → after derived from the PATCH against the profile,
 *    never from a model's preview.
 *
 * The last panel is the card of an answer without a stored proposal: read-only.
 *
 * Pinned to German (`I18nProvider initialLocale="de" fixedLocale`): the copy
 * under review is the German copy. 404s outside development.
 */

import { notFound } from 'next/navigation'
import { I18nProvider } from '@/i18n'
import { FileOperationProposalCard } from '@/features/grid-cards/components/FileOperationProposalCard'
import { MemoryProposalCard } from '@/features/grid-cards/components/MemoryProposalCard'
import { OperationReceipt } from '@/features/grid-cards/components/ProposalReceipts'
import { ProjectProfilePatchCard } from '@/features/grid-cards/components/ProjectProfilePatchCard'
import { DEMO, DEMO_PROJECT_ID, useFakeProposalClient } from '../_fixtures/fake-proposals'

const MOVES = [
  { document: 'Grundriss EG.pdf', source: 'project' as const, current: 'Nachweise', target_folder: 'Einreichung/Pläne' },
  { document: 'Grundriss OG.pdf', source: 'project' as const, current: '', target_folder: 'Einreichung/Pläne' },
  {
    document: 'Schnitt A-A – Bestand und Neubau (Revision 3).pdf',
    source: 'project' as const,
    current: 'Nachweise',
    target_folder: 'Einreichung/Pläne',
  },
]

const NOTE = 'Das Büro setzt bei GK 4 durchgängig REI 90 an, auch wo REI 60 genügen würde.'

const PATCH = [
  { op: 'add' as const, path: '/facts/heat_supply', value: 'waermepumpe' },
  { op: 'add' as const, path: '/facts/escape_level_m', value: 25 },
]
const PROFILE_TITLE = 'Projektkontext aktualisieren: Wärmeversorgung und Fluchtniveau'
const PROFILE_RATIONALE = 'Sie haben im Gespräch eine Wärmepumpe und ein oberstes Fluchtniveau von 25 m genannt.'

function Panel({ title, note, children }: { title: string; note: string; children: React.ReactNode }) {
  return (
    <section className="flex w-[680px] max-w-full flex-col gap-2">
      <h2 className="text-sm font-semibold text-foreground">{title}</h2>
      <p className="text-xs text-muted-foreground">{note}</p>
      {children}
    </section>
  )
}

function Files({ proposalId, title }: { proposalId?: string; title: string }) {
  return (
    <FileOperationProposalCard
      title={title}
      operation="move"
      operations={MOVES}
      proposalId={proposalId}
      cardKey="file_operation_proposal-0"
    />
  )
}

function Memory({ proposalId, supersedes }: { proposalId?: string; supersedes?: string }) {
  return (
    <MemoryProposalCard
      title="Neue Erkenntnis merken"
      content={NOTE}
      kind="preference"
      confidence="high"
      supersedes={supersedes}
      proposalId={proposalId}
      cardKey="memory_proposal-0"
    />
  )
}

function Profile({ proposalId }: { proposalId: string }) {
  return (
    <ProjectProfilePatchCard
      title={PROFILE_TITLE}
      rationale={PROFILE_RATIONALE}
      patch={PATCH}
      projectId={DEMO_PROJECT_ID}
      proposalId={proposalId}
      cardKey="project_profile_patch-0"
    />
  )
}

export default function ProposalReceiptsPreview() {
  if (process.env.NODE_ENV !== 'development') notFound()
  const ready = useFakeProposalClient()

  return (
    <I18nProvider initialLocale="de" fixedLocale>
      <div data-testid="proposal-receipts-preview" className="flex min-h-screen flex-col items-center gap-10 bg-background p-10">
        {ready && (
          <>
            <Panel title="Dateien, offen" note="Drei Verschiebungen unter einer Frage. Übernehmen ruft den Server auf; das Ergebnis je Zeile kommt von dort.">
              <Files proposalId={DEMO.filesOpen} title="Drei Dateien nach „Einreichung/Pläne“ verschieben" />
            </Panel>
            <Panel title="Dateien, von einer Kollegin teilweise übernommen" note="Zwei Zeilen gelungen, eine mit Grund gescheitert; darunter, wer es wann entschieden hat.">
              <Files proposalId={DEMO.filesPartial} title="Drei Dateien nach „Einreichung/Pläne“ verschieben" />
            </Panel>
            <Panel title="Dateien, nur lesbar" note="Der Server sagt: diese Leserin darf es nicht entscheiden. Keine Schaltflächen, dafür der Grund.">
              <Files proposalId={DEMO.filesReadOnly} title="Zwei Dateien nach „Einreichung/Pläne“ verschieben" />
            </Panel>

            <Panel title="Notiz, offen" note="Art und Sicherheit, wohin sie kommt, und neben „Übernehmen“ der schmalere Weg „Nur im Projekt merken“.">
              <Memory proposalId={DEMO.memoryOpen} />
            </Panel>
            <Panel title="Notiz, die eine frühere ersetzt" note="„Ersetzt: …“ zitiert die Notiz, die mit dem Übernehmen zurückgezogen wird.">
              <Memory proposalId={DEMO.memoryCorrection} supersedes="Das Büro setzt bei GK 4 REI 60 an." />
            </Panel>
            <Panel title="Notiz, von einer Kollegin gemerkt" note="Eine Zeile Quittung und wer es wann entschieden hat.">
              <Memory proposalId={DEMO.memoryDecided} />
            </Panel>

            <Panel title="Projektkontext, offen" note="Vorher → nachher aus dem PATCH gegen den heutigen Projektkontext, nie aus einer Vorschau des Modells.">
              <Profile proposalId={DEMO.profileOpen} />
            </Panel>
            <Panel title="Projektkontext, von einer Kollegin übernommen" note="Der Projektkontext enthält die Änderung schon: es bleibt das Nachher.">
              <Profile proposalId={DEMO.profileDecided} />
            </Panel>
            <Panel title="Projektkontext, verworfen" note="Verworfen, und wer es wann getan hat.">
              <Profile proposalId={DEMO.profileDismissed} />
            </Panel>

            <Panel title="Aktion, offen, mit langem Wert" note="Jede Eingabe ganz; ein langer Wert erst gekürzt. „Übernehmen“ wartet, bis jeder gekürzte Wert ganz angezeigt wurde, und „Betrifft“ nennt das Projekt beim Namen.">
              <OperationReceipt proposalId={DEMO.operationOpen} title="Büroanweisungen setzen" operation="organization-instructions-set" input={{}} />
            </Panel>

            <Panel title="Dateien, ohne gespeicherten Vorschlag" note="Eine Antwort aus der Zeit vor den Vorschlägen auf dem Server, oder einer, den der Agent nicht ablegen konnte: lesbar, nicht übernehmbar, mit dem Grund.">
              <Files title="Drei Dateien nach „Einreichung/Pläne“ verschieben" />
            </Panel>
          </>
        )}
      </div>
    </I18nProvider>
  )
}
