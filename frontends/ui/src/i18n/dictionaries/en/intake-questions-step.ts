/**
 * intakeQuestionsStep namespace: step 4, Rückfragen: what the classification still needs, and the documents to hand in (`/app/projects/[id]/setup`, ticket 26,
 * `docs/design/project-setup-five-steps.md`).
 */
export const intakeQuestionsStep = {
  heading: 'Questions',
  description:
    'Only what changes the classification: the decisive details and the documents the location calls for. Answer what you know, hand in a document, or mark it as not known.',
  progress: '{done} of {total} done',
  progressLabel: 'Questions answered',
  readingNote:
    'Piloti is still reading the documents. The questions are complete once the reading has finished. You can answer what you already know now.',
  closingNote:
    'A finished project: Piloti asks only what matters most. Whatever the documents do not state stays “not known”.',
  decisiveHeading: 'Decisive details',
  locationHeading: 'Documents for the location',
  locationPlace: 'What the location calls for in {place}.',
  locationPlaceUnknown: 'Once the federal state is known, Piloti names the documents that apply there.',
  request: {
    sources: 'Basis: {sources}',
    answerInstead: 'Or state it directly',
    unknown: 'Not known',
    unknownAria: '{label}: not known',
  },
  nothing: 'No questions: the documents state everything that decides the classification.',
  done: 'All done. Go on to the profile to confirm what Piloti found.',
  more: 'More details',
  moreHint: 'Optional: none of it changes the classification.',
  next: 'Continue to the profile',
}
