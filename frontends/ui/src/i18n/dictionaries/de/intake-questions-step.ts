import type { en } from '../en'

/** intakeQuestionsStep: step 4, Rückfragen: what the classification still needs, and the documents to hand in. */
export const intakeQuestionsStep: typeof en.intakeQuestionsStep = {
  heading: 'Rückfragen',
  description:
    'Nur was die Einstufung ändert: die entscheidenden Angaben und die Unterlagen, die der Standort verlangt. Beantworten Sie, was Sie wissen, reichen Sie ein Dokument nach oder markieren Sie es als nicht bekannt.',
  progress: '{done} von {total} erledigt',
  progressLabel: 'Erledigte Rückfragen',
  readingNote:
    'Piloti liest die Unterlagen noch. Vollständig sind die Rückfragen, wenn das Lesen abgeschlossen ist. Was Sie schon wissen, können Sie jetzt beantworten.',
  closingNote:
    'Ein abgeschlossenes Projekt: Piloti fragt nur das Wichtigste. Was die Unterlagen nicht nennen, bleibt „nicht bekannt“.',
  decisiveHeading: 'Entscheidende Angaben',
  locationHeading: 'Unterlagen zum Standort',
  locationPlace: 'Was der Standort in {place} verlangt.',
  locationPlaceUnknown: 'Sobald das Bundesland feststeht, nennt Piloti die Unterlagen, die dort gelten.',
  request: {
    sources: 'Grundlage: {sources}',
    answerInstead: 'Oder direkt angeben',
    unknown: 'Nicht bekannt',
    unknownAria: '{label}: nicht bekannt',
  },
  nothing: 'Keine Rückfragen: Die Unterlagen nennen alles, was die Einstufung entscheidet.',
  done: 'Alles erledigt. Im Steckbrief bestätigen Sie, was Piloti gefunden hat.',
  more: 'Weitere Angaben',
  moreHint: 'Freiwillig: Nichts davon ändert die Einstufung.',
  next: 'Weiter zum Steckbrief',
}
