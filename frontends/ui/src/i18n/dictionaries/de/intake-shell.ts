import type { en } from '../en'

/** intakeShell: der Rahmen der Einrichtung in fünf Schritten: Schrittleiste, Seitenkopf und der Weg zurück aus der Übersicht. */
export const intakeShell: typeof en.intakeShell = {
  head: {
    eyebrow: 'Einrichtung',
    later: 'Später fortsetzen',
    laterAria: 'Die Einrichtung verlassen und zur Projektübersicht gehen. Piloti liest weiter, die Einrichtung wartet dort.',
    stepMenu: 'Schritt {current} von {total}: {step}. Anderen Schritt wählen',
  },
  steps: {
    label: 'Schritte der Einrichtung',
    progress: 'Schritt {current} von {total}',
    project: 'Projekt',
    filing: 'Ablage',
    reading: 'Erfassung',
    questions: 'Rückfragen',
    profile: 'Steckbrief',
  },
  footer: {
    next: 'Weiter zu {step}',
  },
  notes: {
    documents: '{count, plural, one {# Dokument} other {# Dokumente}}',
    read: '{count} gelesen',
    readOf: '{read} von {total}',
    failed: 'unterbrochen',
    open: '{count} offen',
    contradictions: '{count, plural, one {# Widerspruch} other {# Widersprüche}}',
    values: '{count, plural, one {# Wert} other {# Werte}}',
    done: 'abgeschlossen',
  },
  overview: {
    reading: 'Piloti liest noch',
    questions: '{count, plural, one {# Rückfrage offen} other {# Rückfragen offen}}',
    contradictions: '{count, plural, one {# Widerspruch offen} other {# Widersprüche offen}}',
    review: 'Steckbrief zu prüfen',
  },
}
