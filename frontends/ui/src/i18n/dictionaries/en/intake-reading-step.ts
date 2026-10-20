/**
 * intakeReadingStep namespace: step 3, Erfassung: the reading in the background, its progress, and leaving while it runs (`/app/projects/[id]/setup`, ticket 26,
 * `docs/design/project-setup-five-steps.md`).
 */
export const intakeReadingStep = {
  heading: {
    waiting: 'No documents yet',
    waitingWithDocuments: 'The documents are here',
    reading: 'Piloti is reading your documents',
    ready: 'Piloti has read your documents',
    failed: 'The reading was interrupted',
    completed: 'The setup is finished',
  },
  lead: {
    waiting: 'Piloti starts reading as soon as documents are in the filing.',
    waitingWithDocuments: 'Piloti will start reading in a moment.',
    reading:
      'The document agent reads every document and looks for details of the site as it goes. What it finds shows here as soon as it has it.',
    ready: 'You review what Piloti found in the next steps.',
    failed: 'What Piloti found until then stays. Start another attempt in the notice above.',
    completed: 'Every value is confirmed.',
  },
  toFiling: 'Go to filing',
  milestones: {
    label: 'Progress of the reading',
    site: {
      done: 'Site determined',
      searching: 'Looking for the site',
      open: 'Site still open',
      openDetail: 'Piloti asks for it among the questions.',
      searchingDetail: 'The state and municipality are usually in the title block or the building description.',
      sources: {
        geocoder: 'from the address search',
        document: 'from the documents',
        documentSuggested: 'from the documents, still to confirm',
        person: 'your entry',
      },
    },
    documents: {
      title: '{read} of {total} documents read',
      none: 'No document read yet',
      all: '{count, plural, one {# document read} other {# documents read}}',
      aria: 'Reading progress: {read} of {total} documents',
      rest: '{count, plural, one {# document is not read yet} other {# documents are not read yet}}',
    },
    values: {
      title: '{count, plural, one {# value found} other {# values found}}',
      none: 'No values found yet',
      detail: 'Each with the page it is on.',
    },
    contradictions: {
      title: '{count, plural, one {# contradiction} other {# contradictions}}',
      none: 'No contradictions',
      detail: 'The documents give different values for the same detail. You decide in the profile.',
    },
    gaps: {
      title: '{count, plural, one {# gap} other {# gaps}}',
      none: 'No gaps',
      detail: 'Details that decide the building class and are in no document.',
      noneDetail: 'Everything that decides the building class is in the documents.',
    },
    states: {
      done: 'done',
      active: 'in progress',
      pending: 'pending',
      attention: 'needs you',
    },
  },
  summary: {
    heading: 'What Piloti says about it',
    pending: 'Piloti sums up once it has finished reading.',
  },
  leave: {
    title: 'You can leave this page',
    body: 'We will notify you when Piloti is done. You can already ask about the uploaded documents in the project chat.',
  },
  askChat: 'Ask in the chat',
  askChatAria: 'Open the project chat and ask Piloti about the documents',
  next: 'On to the questions',
}
