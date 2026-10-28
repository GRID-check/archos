/**
 * intakeQuestionsStep namespace: step 4, Rückfragen: one question at a time, only what changes the classification
 * (`/app/projects/[id]/setup`, ticket 26, `docs/design/project-setup-five-steps.md`).
 */
export const intakeQuestionsStep = {
  heading: 'Questions',
  subtitle: 'Only what changes the classification',
  groups: {
    missing: 'Missing from the documents',
    location: 'Documents for the location',
    contradiction: 'Contradiction',
  },
  list: {
    done: 'done',
    current: 'asked now',
    open: 'open',
  },
  progress: '{done} of {total} done',
  readingNote: '{productName} is still reading the documents. You can answer what you already know now.',
  closingNote: 'A finished project: {productName} asks only what matters most.',
  card: {
    position: 'Question {index} of {total}',
    submit: 'Use and continue',
    submitting: 'Saving …',
    unknown: "I don't know",
    unknownBusy: 'Noting …',
    unknownAria: "{label}: I don't know",
    later: 'Decide later',
    laterAria: '{label}: decide later',
  },
  why: {
    decisive: 'decides the building class',
    register: 'sets what the location calls for',
    location: 'called for by the location in {place}',
    locationUnknown: 'called for by the location',
    contradiction: 'the documents state different values',
  },
  or: 'or',
  handIn: {
    where: 'Usually found in:',
    wherePhone: 'Usually found in: {where}',
    drop: 'Drop it here, {productName} reads the answer out of it.',
    pick: 'Choose file',
    pickAria: 'Choose file for: {label}',
  },
  request: {
    sources: 'Basis: {sources}',
    unknownAria: "{label}: I don't know",
    documentOnly: 'Hand in the document below, {productName} reads the values from it.',
  },
  contradiction: {
    title: '{label}: {values}?',
    description: 'The documents state different values. Choose the one that holds.',
    choose: 'Value that holds',
    current: 'in the profile',
    found: 'also found',
  },
  value: {
    unknown: 'not known',
    handedIn: 'file handed in',
  },
  doneTitle: 'All questions answered',
  done: 'In the profile you confirm what {productName} found.',
  nothingTitle: 'No questions',
  nothing: 'The documents state everything that decides the classification.',
  waitingTitle: 'No questions yet',
  waiting: '{productName} is still reading the documents. Whatever stays open will be asked here.',
  more: 'More details',
  moreHint: 'Optional: none of it changes the classification.',
  moreClose: 'Close',
  rest: 'Rest later, on to the profile',
  next: 'Continue to the profile',
}
