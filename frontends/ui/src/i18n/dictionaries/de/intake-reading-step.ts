import type { en } from '../en'

/**
 * intakeReadingStep: Schritt 3, Erfassung. Piloti liest im Hintergrund; die
 * Seite zeigt, was dabei schon feststeht, und sagt, dass man gehen kann.
 * Ruhig und ehrlich: nur Zahlen, die der Server wirklich kennt.
 */
export const intakeReadingStep: typeof en.intakeReadingStep = {
  heading: {
    waiting: 'Noch keine Unterlagen',
    waitingWithDocuments: 'Die Unterlagen sind da',
    reading: 'Piloti liest Ihre Unterlagen',
    ready: 'Piloti hat Ihre Unterlagen gelesen',
    failed: 'Das Lesen wurde unterbrochen',
    completed: 'Die Erfassung ist abgeschlossen',
  },
  lead: {
    waiting: 'Piloti liest, sobald Dokumente in der Ablage liegen.',
    waitingWithDocuments: 'Piloti beginnt gleich mit dem Lesen.',
    reading:
      'Der Dokumenten-Agent liest jedes Dokument und sucht dabei auch nach Angaben zum Standort. Was er findet, erscheint hier, sobald er es hat.',
    ready: 'Was Piloti gefunden hat, prüfen Sie in den nächsten Schritten.',
    failed: 'Was Piloti bis dahin gefunden hat, bleibt. Einen neuen Versuch starten Sie in der Meldung oben.',
    completed: 'Alle Werte sind bestätigt.',
  },
  toFiling: 'Zur Ablage',
  milestones: {
    label: 'Fortschritt der Erfassung',
    site: {
      done: 'Standort ermittelt',
      searching: 'Standort wird gesucht',
      open: 'Standort noch offen',
      openDetail: 'Piloti fragt bei den Rückfragen danach.',
      searchingDetail: 'Bundesland und Gemeinde stehen meist im Schriftfeld oder in der Baubeschreibung.',
      sources: {
        geocoder: 'aus der Adresssuche',
        document: 'aus den Unterlagen',
        documentSuggested: 'aus den Unterlagen, noch zu bestätigen',
        person: 'Ihre Angabe',
      },
    },
    documents: {
      title: '{read} von {total} Dokumenten gelesen',
      none: 'Noch kein Dokument gelesen',
      all: '{count, plural, one {# Dokument gelesen} other {# Dokumente gelesen}}',
      aria: 'Lesefortschritt: {read} von {total} Dokumenten',
      rest: '{count, plural, one {# Dokument ist noch nicht gelesen} other {# Dokumente sind noch nicht gelesen}}',
    },
    values: {
      title: '{count, plural, one {# Wert gefunden} other {# Werte gefunden}}',
      none: 'Noch keine Werte gefunden',
      detail: 'Jeder mit der Seite, auf der er steht.',
    },
    contradictions: {
      title: '{count, plural, one {# Widerspruch} other {# Widersprüche}}',
      none: 'Keine Widersprüche',
      detail: 'Die Unterlagen nennen für dieselbe Angabe verschiedene Werte. Sie entscheiden im Steckbrief.',
    },
    gaps: {
      title: '{count, plural, one {# Lücke} other {# Lücken}}',
      none: 'Keine Lücken',
      detail: 'Angaben, die die Gebäudeklasse entscheiden und in keinem Dokument stehen.',
      noneDetail: 'Alles, was die Gebäudeklasse entscheidet, steht in den Unterlagen.',
    },
    states: {
      done: 'erledigt',
      active: 'läuft',
      pending: 'ausstehend',
      attention: 'braucht Sie',
    },
  },
  summary: {
    heading: 'Was Piloti dazu sagt',
    pending: 'Piloti fasst zusammen, sobald es fertig gelesen hat.',
  },
  leave: {
    title: 'Sie können diese Seite verlassen',
    body: 'Wir benachrichtigen Sie, wenn Piloti fertig ist. Fragen zu den hochgeladenen Unterlagen stellen Sie schon jetzt im Projekt-Chat.',
  },
  askChat: 'Im Chat fragen',
  askChatAria: 'Den Projekt-Chat öffnen und Piloti zu den Unterlagen fragen',
  next: 'Weiter zu den Rückfragen',
}
