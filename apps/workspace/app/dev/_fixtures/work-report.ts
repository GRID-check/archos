/**
 * Fixtures for `/dev/work-report`: the states of the closing block of an
 * operations turn (`kind: work`, ADR-0123). The panel titles and notes are
 * review copy for the preview, German like the neighbouring previews; the
 * card's own copy comes from the dictionaries. The "full mix" state is the
 * shared payload of `tests/fixtures/answer_meta/work_payload.json`.
 */

import type { AnswerMetaWork } from '@/lib/conversations/message-answer-meta'
import { PRODUCT_NAME } from '@/lib/brand'

export interface WorkReportScenario {
  id: string
  title: string
  note: string
  work: AnswerMetaWork
}

export const WORK_REPORT_SCENARIOS: readonly WorkReportScenario[] = [
  {
    id: 'done-only',
    title: 'Nur Erledigtes',
    note: 'Ein Zug, der nur gelesen hat: allein „Erledigt“, keine leeren Abschnitte darüber.',
    work: {
      done: [
        { text: 'Projektmitglieder und Ordner des Kindergartens Baden gelesen' },
        { text: 'Die drei offenen Freigaben mit dem Stand im Projekt abgeglichen' },
      ],
    },
  },
  {
    id: 'proposed',
    title: 'Vorgeschlagen, wartet auf Sie',
    note: 'Zeilen mit Verweis auf den Vorschlag. Die Zeile entscheidet nichts, das tut die Karte des Vorschlags.',
    work: {
      proposed: [
        {
          text: 'Thomas Wagner als Bearbeiter ins Projekt aufnehmen',
          ref: '6f7a8b9c-0d1e-4f2a-9b3c-4d5e6f7a8b9c',
        },
        { text: 'Ordner Ausschreibung anlegen', ref: '7a8b9c0d-1e2f-4a3b-8c4d-5e6f7a8b9c0d' },
      ],
    },
  },
  {
    id: 'blocked',
    title: 'Blockiert, mit Wer',
    note: 'Was ' + PRODUCT_NAME + ' nicht konnte, und bei wem es liegt: „Wer: …“ hinter der Zeile.',
    work: {
      blocked: [
        { text: 'Brandschutzkonzept fehlt im Projekt', who: 'Fachplaner Brandschutz' },
        { text: 'Statik für den Anbau liegt nur als Entwurf vor', who: 'Tragwerksplanerin' },
      ],
    },
  },
  {
    id: 'next',
    title: 'Als Nächstes',
    note: 'Der nächste Schritt, wer ihn tut und bis wann.',
    work: {
      next: [
        {
          text: 'Vorschläge annehmen, dann lege ich die Ausschreibungsunterlagen an',
          who: 'Lena Berger',
          due: 'heute',
        },
        { text: 'Statik nachfordern', due: 'Freitag' },
      ],
    },
  },
  {
    id: 'full',
    title: 'Alles zusammen',
    note: 'Reihenfolge, in der die Person handelt: Entscheidungen zuerst, dann Blockiertes, Nächstes, zuletzt Erledigtes.',
    work: {
      done: [{ text: 'Projektmitglieder und Ordner des Kindergartens Baden gelesen' }],
      proposed: [
        {
          text: 'Thomas Wagner als Bearbeiter ins Projekt aufnehmen',
          ref: '6f7a8b9c-0d1e-4f2a-9b3c-4d5e6f7a8b9c',
        },
        { text: 'Ordner Ausschreibung anlegen', ref: '7a8b9c0d-1e2f-4a3b-8c4d-5e6f7a8b9c0d' },
      ],
      blocked: [{ text: 'Brandschutzkonzept fehlt im Projekt', who: 'Fachplaner Brandschutz' }],
      next: [
        {
          text: 'Vorschläge annehmen, dann lege ich die Ausschreibungsunterlagen an',
          who: 'Lena Berger',
          due: 'heute',
        },
      ],
    },
  },
  {
    id: 'empty-hidden',
    title: 'Leere Listen',
    note: 'Leere Abschnitte und Zeilen ohne Text fallen weg; hier bleibt nur „Als Nächstes“. Ohne jede Zeile zeichnet der Block nichts.',
    work: {
      done: [],
      proposed: [{ text: '' }],
      blocked: [],
      next: [{ text: 'Statik nachfordern' }],
    },
  },
]
