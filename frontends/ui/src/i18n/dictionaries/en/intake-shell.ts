/**
 * intakeShell namespace: the five-step setup frame: the stepper, step navigation, the page head (`/app/projects/[id]/setup`, ticket 26,
 * `docs/design/project-setup-five-steps.md`), and the overview's way back into it. German is the product language; this is the English twin.
 */
export const intakeShell = {
  head: {
    eyebrow: 'Setup',
    later: 'Continue later',
    laterAria: 'Leave the setup for the project overview. Piloti keeps reading, and the setup waits there.',
    stepMenu: 'Step {current} of {total}: {step}. Choose another step',
  },
  steps: {
    label: 'Steps of the setup',
    progress: 'Step {current} of {total}',
    project: 'Project',
    filing: 'Filing',
    reading: 'Reading',
    questions: 'Questions',
    profile: 'Profile',
  },
  footer: {
    next: 'On to {step}',
  },
  notes: {
    documents: '{count, plural, one {# document} other {# documents}}',
    read: '{count} read',
    readOf: '{read} of {total}',
    failed: 'interrupted',
    open: '{count} open',
    values: '{count, plural, one {# value} other {# values}}',
    done: 'finished',
  },
  overview: {
    reading: 'Piloti is still reading',
    questions: '{count, plural, one {# question open} other {# questions open}}',
    contradictions: '{count, plural, one {# contradiction open} other {# contradictions open}}',
    review: 'Profile to check',
  },
}
