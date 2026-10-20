/**
 * intakeProfileStep namespace: step 5, Steckbrief: contradictions, values, derivations, finishing (`/app/projects/[id]/setup`, ticket 26,
 * `docs/design/project-setup-five-steps.md`).
 */
export const intakeProfileStep = {
  /** How sure a value is, in words: who confirmed it and how many sources agree. Never a number. */
  confidence: {
    confirmed: 'Confirmed',
    ownAnswer: 'Your answer',
    contested: '{count} different values found',
    corroborated: 'Suggestion, {count} sources agree',
    single: 'Suggestion from one source',
    unsupported: 'Suggestion without a source',
  },
  /** The excerpt of the cited page beside a value. */
  excerpt: {
    show: 'Excerpt',
    showAria: 'Show the excerpt of {name}, page {page}',
    hideAria: 'Hide the excerpt of {name}, page {page}',
    figure: 'Excerpt of {name}, page {page}',
    loading: 'Loading the page …',
    wholePage: 'The passage cannot be marked on this page. You are seeing the whole page.',
    unavailable: 'There is no excerpt for this page. The source chip opens the document.',
  },
  decisive: {
    heading: 'Decisive values',
    description: 'These values decide the Gebäudeklasse. Check each one where it was found and use it on its own.',
    position: '{index} of {total}',
    confirm: 'Use',
    confirmAria: 'Use {value} for {label}',
    dismiss: 'Discard',
    dismissAria: 'Discard {value} for {label}',
  },
  rest: {
    heading: 'Other values',
    description: 'Grouped by topic. Discard anything wrong, then use the rest in one go.',
  },
  derivations: {
    basedOnSuggested:
      '{count, plural, one {Rests on # value nobody has confirmed yet.} other {Rests on # values nobody has confirmed yet.}}',
  },
  /** The rule set's Ampel: the applicability panel, from the confirmed values. */
  rules: {
    heading: 'Rule sets',
    description: 'Which OIB-Richtlinien apply to the project, worked out from the confirmed values.',
    basisNone: 'No value is confirmed yet, so the general list applies. A suggestion counts once you use it.',
    basis:
      '{count, plural, one {Worked out from # confirmed value.} other {Worked out from # confirmed values.}} A suggestion counts once you use it.',
    classPending:
      'The Gebäudeklasse is not confirmed yet. Once you use it under derivations, the classification gets more precise.',
  },
}
