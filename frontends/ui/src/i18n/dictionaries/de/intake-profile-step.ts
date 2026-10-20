import type { en } from '../en'

/** intakeProfileStep: Schritt 5, Steckbrief: Widersprüche, entscheidende Werte, der Rest, Ableitungen, Regelwerke, Abschluss. */
export const intakeProfileStep: typeof en.intakeProfileStep = {
  confidence: {
    confirmed: 'Bestätigt',
    ownAnswer: 'Ihre Angabe',
    contested: '{count} verschiedene Werte gefunden',
    corroborated: 'Vorschlag, {count} Quellen stimmen überein',
    single: 'Vorschlag aus einer Quelle',
    unsupported: 'Vorschlag ohne Beleg',
  },
  excerpt: {
    show: 'Ausschnitt',
    showAria: 'Ausschnitt aus {name}, Seite {page} zeigen',
    hideAria: 'Ausschnitt aus {name}, Seite {page} ausblenden',
    figure: 'Ausschnitt aus {name}, Seite {page}',
    loading: 'Die Seite wird geladen …',
    wholePage: 'Die Stelle lässt sich auf der Seite nicht markieren. Sie sehen die ganze Seite.',
    unavailable: 'Für diese Seite gibt es keinen Ausschnitt. Der Beleg öffnet das Dokument.',
  },
  decisive: {
    heading: 'Entscheidende Werte',
    description:
      'Diese Werte bestimmen die Gebäudeklasse. Prüfen Sie jeden an seiner Fundstelle und übernehmen Sie ihn einzeln.',
    position: '{index} von {total}',
    confirm: 'Übernehmen',
    confirmAria: '{value} für {label} übernehmen',
    dismiss: 'Verwerfen',
    dismissAria: '{value} für {label} verwerfen',
  },
  rest: {
    heading: 'Übrige Werte',
    description: 'Nach Themen geordnet. Verwerfen Sie, was nicht stimmt, und übernehmen Sie den Rest auf einmal.',
  },
  derivations: {
    basedOnSuggested:
      '{count, plural, one {Beruht auf # Wert, den noch niemand bestätigt hat.} other {Beruht auf # Werten, die noch niemand bestätigt hat.}}',
  },
  rules: {
    heading: 'Regelwerke',
    description: 'Welche OIB-Richtlinien für das Projekt gelten, berechnet aus den bestätigten Werten.',
    basisNone: 'Noch ist kein Wert bestätigt, daher gilt die allgemeine Liste. Ein Vorschlag zählt erst, wenn Sie ihn übernehmen.',
    basis:
      '{count, plural, one {Berechnet aus # bestätigten Wert.} other {Berechnet aus # bestätigten Werten.}} Ein Vorschlag zählt erst, wenn Sie ihn übernehmen.',
    classPending:
      'Die Gebäudeklasse ist noch nicht bestätigt. Sobald Sie sie bei den Ableitungen übernehmen, wird die Einstufung genauer.',
  },
}
