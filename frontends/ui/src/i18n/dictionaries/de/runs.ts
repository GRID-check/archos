import type { en } from '../en'

/**
 * Läufe — wie ein Lauf im Verlauf liest, der ihn beauftragt hat (der Laufblock).
 *
 * Das Ledger trägt ASCII-Schlüssel (`planen`, `laeuft`); hier stehen die Wörter
 * dafür und der Satz, den jeder Status dem Leser schuldet. Keine Kennung
 * erreicht den Leser, jede Phase ist ein Wort, jeder Status ein Wort und ein
 * Satz, und eine Zahl steht nur dort, wo sie ändert, was der Leser als Nächstes
 * tut.
 */
export const runs: typeof en.runs = {
  phase: {
    planning: 'Planen',
    researching: 'Recherchieren',
    checking: 'Prüfen',
    writing: 'Schreiben',
    filed: 'Abgelegt',
  },
  status: {
    created: 'Wird gestartet',
    running: 'Läuft',
    waiting: 'Wartet auf Sie',
    done: 'Fertig',
    failed: 'Fehlgeschlagen',
    cancelled: 'Abgebrochen',
    interrupted: 'Unterbrochen',
  },
  line: {
    filing: 'Ergebnis kommt ins Projekt',
    waiting: 'Antworten Sie unten im Verlauf',
    doneFiled: 'Bericht abgelegt in Projekt › Berichte',
    doneInline: 'Der Bericht liegt hier im Verlauf',
    failed: 'Fehlgeschlagen: {reason}',
    cancelled: 'auf Ihren Wunsch beendet',
    interrupted: 'Bericht aus dem Vorhandenen geschrieben',
  },
  completedBefore: 'Bis dahin: {phases}',
  completedBeforeTallies: '{phase} ({rounds}, {docs})',
  step: {
    fallback: 'Recherche-Runde {n}',
    round: 'Runde {n}',
    repeat: 'bereits gelesen',
    openPoints: 'Offen:',
    findings: 'Bisher belegt',
  },
  phaseLine: {
    planning: 'Rechercheplan erstellt',
    checking: 'Zitate gegen die Quellen geprüft',
    checkingLive: 'Zitate werden gegen die Quellen geprüft',
    writing: 'Bericht geschrieben',
    writingLive: 'Bericht wird geschrieben',
  },
  tallies: {
    rounds: '{count, plural, one {# Runde} other {# Runden}}',
    docs: '{count, plural, one {# Dokument} other {# Dokumente}}',
    findings: '{count, plural, one {# Befund} other {# Befunde}}',
  },
  action: {
    answer: 'Antworten',
    review: 'Prüfen',
    openReport: 'Bericht öffnen',
    openInProject: 'Im Projekt anzeigen',
    retry: 'Erneut starten',
    openInThread: 'Im Verlauf öffnen',
    cancel: 'Abbrechen',
    writeNow: 'Jetzt schreiben',
    continue: 'Bericht fortschreiben',
    /** Statt „Bericht fortschreiben“ in einem abgeschlossenen Projekt (ADR-0090): ein Lauf legt dort ab. */
    continueClosed: 'Abgeschlossenes Projekt: keine neue Recherche',
  },
  documents: {
    receiptLabel: 'Für diesen Lauf benannte Unterlagen',
    receipt: '{read} von {total} benannten Unterlagen gelesen',
    unread: 'nicht gelesen',
    open: '{name} öffnen',
    addAction: 'Unterlage hinzufügen',
    addTitle: 'Unterlage hinzufügen',
    addDescription:
      '{productName} liest sie in der nächsten Recherche-Runde vollständig und führt sie bei den übrigen benannten Unterlagen.',
    pickTitle: 'Unterlagen wählen',
    pickDescription:
      '„Lesen" heißt vollständig lesen, was immer die Recherche sonst findet. „Ausschließen" heißt nie verwenden, auch nicht, wenn eine Suche sie liefert.',
    search: 'Unterlagen durchsuchen',
    searchPlaceholder: 'Nach Namen suchen …',
    list: 'Unterlagen',
    loading: 'Unterlagen werden geladen …',
    empty: 'Keine passenden Unterlagen.',
    read: 'Lesen',
    exclude: 'Ausschließen',
    markRead: 'Vollständig lesen: {name}',
    markExcluded: 'Ausschließen: {name}',
    add: 'Hinzufügen',
    addOne: '{name} hinzufügen',
    alreadyNamed: 'benannt',
    addFailed: 'Die Unterlage hat den Lauf nicht erreicht. Bitte erneut versuchen.',
    restricted: 'eingeschränkt',
    restrictedReason:
      'Liegt in einem Ordner mit eingeschränktem Zugriff. Unterlagen und Bericht einer Recherche sind für alle im Projekt sichtbar, deshalb lässt sie sich nicht hinzufügen.',
    done: 'Fertig',
    shelf: { project: 'Projekt', office_shelf: 'Büroablage', session: 'Dieser Chat', base: 'Regelwerke' },
  },
  cancel: {
    confirmTitle: 'Lauf abbrechen?',
    confirmBody:
      '{productName} hört dort auf, wo es gerade ist. Was bis dahin recherchiert wurde, bleibt im Block stehen; der Bericht wird nicht mehr geschrieben.',
    confirm: 'Lauf abbrechen',
    keep: 'Weiterlaufen lassen',
  },
  review: {
    accepted: 'Angenommen von {name}',
    acceptedAnon: 'Angenommen',
    rejected: 'Zurückgeschickt: {reason}',
    rejectedAnon: 'Zurückgeschickt',
  },
  connection: {
    reconnecting:
      'Die Live-Ansicht hat die Verbindung verloren und verbindet neu. Der Lauf geht weiter.',
    lost: 'Die Live-Ansicht ist getrennt. Der Lauf geht weiter — zum Mitlesen neu laden.',
  },
  block: {
    aria: 'Lauf {title}: {status}',
    toggle: 'Verlauf des Laufs ein- oder ausblenden',
    untitled: 'Lauf',
    elapsedAria: 'Laufzeit {elapsed}',
  },
}
