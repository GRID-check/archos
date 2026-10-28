import type { en } from '../en'

/**
 * intakeReadingStep: Schritt 3, Erfassung. Piloti liest im Hintergrund; die
 * Seite zeigt, was dabei schon feststeht, und sagt, dass man nicht warten muss.
 * Ruhig und ehrlich: nur Zahlen, die der Server wirklich kennt.
 */
export const intakeReadingStep: typeof en.intakeReadingStep = {
  heading: {
    waiting: 'Noch keine Unterlagen',
    waitingWithDocuments: '{productName} liest gleich Ihre Unterlagen',
    reading: '{productName} liest Ihre Unterlagen',
    ready: '{productName} hat Ihre Unterlagen gelesen',
    failed: '{productName} hat das Lesen unterbrochen',
    completed: '{productName} hat Ihre Unterlagen gelesen',
  },
  lead: {
    failed: 'Was {productName} bis dahin gefunden hat, bleibt. Ein neuer Versuch liest, was noch fehlt.',
    waiting: '{productName} liest, sobald Dokumente in der Ablage liegen.',
    waitingWithDocuments: 'Die Unterlagen sind da. Das Lesen beginnt in einem Moment.',
  },
  retry: 'Erneut lesen',
  retryBusy: 'Wird gestartet …',
  nextAnyway: 'Trotzdem weiter zu den Rückfragen',
  documents: {
    of: '{read} von {total} gelesen',
    read: '{count, plural, one {# Dokument gelesen} other {# Dokumente gelesen}}',
    aria: '{read} von {total} Dokumenten gelesen',
    unread: '{count, plural, one {# Dokument noch nicht gelesen} other {# Dokumente noch nicht gelesen}}',
    reread: 'Jetzt lesen',
    rereadAria: '{count, plural, one {Das Dokument lesen, das noch nicht gelesen ist} other {Die # Dokumente lesen, die noch nicht gelesen sind}}',
    rereadBusy: 'Wird gestartet …',
    add: 'Dokumente hinzufügen',
    addFiles: 'Dateien auswählen',
    addFolder: 'Ordner auswählen',
    uploading: 'Wird hochgeladen …',
  },
  milestones: {
    label: 'Fortschritt der Erfassung',
    later: 'nach dem Lesen',
    none: 'keine',
    noneYet: 'bisher keine',
    site: {
      done: 'Standort ermittelt',
      suggested: 'Standort gefunden',
      searching: 'Standort wird gesucht',
      open: 'Standort noch offen',
      asked: 'bei den Rückfragen',
      toConfirm: 'zu bestätigen',
    },
    values: { label: 'Werte gefunden' },
    contradictions: { label: 'Widersprüche' },
    gaps: { label: 'Lücken, die die Gebäudeklasse entscheiden' },
    states: {
      done: 'erledigt',
      active: 'läuft',
      pending: 'noch nicht',
      attention: 'braucht Sie',
    },
  },
  found: {
    fresh: 'Gerade gefunden',
    soFar: 'Bisher gefunden',
    sample: 'Gefunden, unter anderem',
    source: '{name}, S. {page}',
    all: '{count, plural, one {Im Steckbrief ansehen} other {Alle # im Steckbrief}}',
  },
  summary: {
    toggle: 'Was {productName} dazu sagt',
  },
  band: {
    waiting: 'Im Chat können Sie {productName} schon jetzt fragen, mit oder ohne Unterlagen.',
    reading: 'Sie müssen nicht warten. {productName} meldet sich, wenn es fertig ist.',
    ready: 'Zu allem, was {productName} gelesen hat, können Sie jetzt im Chat fragen.',
    failed: 'Zu dem, was {productName} bis dahin gelesen hat, können Sie schon im Chat fragen.',
  },
  chat: {
    early: 'Schon jetzt im Chat fragen',
    label: 'Im Chat fragen',
    aria: 'Den Projekt-Chat öffnen und {productName} zu den Unterlagen fragen',
  },
  toFiling: 'Zur Ablage',
  withoutDocuments: 'Ohne Unterlagen weiter',
  next: 'Weiter zu den Rückfragen',
}
