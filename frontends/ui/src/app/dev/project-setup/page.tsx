'use client'

/**
 * The setup page (five steps, ticket 26) drawn from fixtures, so every step in
 * every state can be looked at and screenshotted without a database, a worker
 * or a reading: `?step=project | filing | reading | questions | profile`
 * (default: the step the page itself would open on) and
 * `?state=waiting | reading | failed | ready | closing | completed` (default
 * `ready`), plus `?busy=1` for a call in flight. The step rides the address as
 * it does on the real page, so the stepper, back and forward work here too.
 * The document chips open a PDF built from the fixtures' own quotes, in the
 * viewer the chat's citations use.
 *
 * Decisions call back into the page, which shows the last payload it was given
 * instead of changing the fixture: what a button sends is the thing to review.
 * Uploads go nowhere here.
 *
 * `ready` and `closing` carry Piloti's two open filing suggestions („Ablage“).
 * Their apply and dismiss go to a faked proposals API (`fake-proposals.ts`), so
 * the buttons can be pressed; a decided suggestion leaves the section.
 */

import { use, useMemo, useState } from 'react'
import { useFakeProposalClient } from '@/app/dev/_fixtures/fake-proposals'
import {
  INTAKE_FILING,
  INTAKE_FILING_STATES,
  INTAKE_FIXTURES,
  type IntakeFixtureName,
} from '@/app/dev/_fixtures/project-intake'
import { installFixtureDocuments } from './fixture-documents'
import { IntakeSetupView } from '@/features/project-intake/components/intake-setup-view'
import {
  createFixtureParticipantsClient,
  isProjectStepState,
} from '@/app/dev/_fixtures/project-setup-project'
import {
  PROFILE_STEP_FIXTURES,
  type ProfileStepFixtureName,
} from '@/app/dev/_fixtures/project-setup-profile'
import { QUESTIONS_FIXTURES } from '@/app/dev/_fixtures/project-setup-questions'
import { READING_FIXTURES } from '@/app/dev/_fixtures/project-setup-reading'
import { useFilingSuggestions } from '@/features/documents/hooks/use-filing-suggestions'
import type { IntakeDecision } from '@/lib/project-intake/types'

installFixtureDocuments(INTAKE_FIXTURES.ready)

/** The project the fixtures describe, named as the create dialog would have. */
const FIXTURE_PROJECT_NAME = 'Wohnanlage Gartenstraße 12'

function stateOf(value: string | string[] | undefined): IntakeFixtureName {
  const name = Array.isArray(value) ? value[0] : value
  return name && name in INTAKE_FIXTURES ? (name as IntakeFixtureName) : 'ready'
}

export default function ProjectSetupPreviewPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const params = use(searchParams)
  const name = stateOf(params.state)
  const busy = params.busy === '1'
  // `?profile=review | confirmed | hochhaus | readonly` draws the Steckbrief's own
  // fixtures (with the rule set's Ampel computed by the real function).
  const profileName =
    typeof params.profile === 'string' && params.profile in PROFILE_STEP_FIXTURES
      ? (params.profile as ProfileStepFixtureName)
      : null
  // `?questions=ready | typed-address | reading | closing | done` draws step 4's
  // own fixtures, with the location register filled in.
  const questionsName =
    typeof params.questions === 'string' && params.questions in QUESTIONS_FIXTURES
      ? (params.questions as keyof typeof QUESTIONS_FIXTURES)
      : null
  // `?reading=waiting | queued | reading | … | completed` draws step 3's fixtures.
  const readingName =
    typeof params.reading === 'string' && params.reading in READING_FIXTURES
      ? (params.reading as keyof typeof READING_FIXTURES)
      : null
  const view = readingName
    ? READING_FIXTURES[readingName]
    : profileName
      ? PROFILE_STEP_FIXTURES[profileName]
      : questionsName
        ? QUESTIONS_FIXTURES[questionsName]
        : INTAKE_FIXTURES[name]
  const [sent, setSent] = useState<string | null>(null)
  // Step 1 reads the Beteiligte from its own API; here from an in-memory one
  // (`?project=fresh | team | viewer | closing`), made once per state.
  const projectState = isProjectStepState(params.project) ? params.project : 'team'
  const participantsClient = useMemo(
    () => createFixtureParticipantsClient(projectState),
    [projectState]
  )
  // The connected page's own hook, against a faked proposals API: a decided
  // suggestion is read away, as it is there.
  const proposalsReady = useFakeProposalClient(INTAKE_FILING)
  const filing = useFilingSuggestions({
    query:
      proposalsReady && INTAKE_FILING_STATES.includes(name) ? { projectId: view.projectId } : null,
    watching: false,
  })

  return (
    // The real page fills the shell's content area; here the viewport.
    <div className="bg-background h-dvh" data-testid="project-setup-preview">
      <IntakeSetupView
        // A new state is a new page: the step it opens on is chosen again.
        key={`${name}-${projectState}-${profileName ?? ''}-${questionsName ?? ''}-${readingName ?? ''}`}
        participantsClient={participantsClient}
        view={view}
        projectId={view.projectId}
        projectName={FIXTURE_PROJECT_NAME}
        busy={busy}
        stale={false}
        canUpload
        uploading={false}
        onFiles={(files) => setSent(`files: ${files.map((file) => file.name).join(', ')}`)}
        onDecide={async (decisions: IntakeDecision[]) => {
          setSent(`decide: ${JSON.stringify(decisions)}`)
          return true
        }}
        onReread={() => setSent('start: {"scope":"new"}')}
        onComplete={async () => {
          setSent('complete')
          return true
        }}
        onRetry={() => setSent('get')}
        filing={{ entries: filing.byFolder, onSettled: filing.reload }}
      />
      {sent && (
        <pre className="bg-card text-muted-foreground fixed bottom-24 left-4 z-50 max-h-40 max-w-md overflow-auto whitespace-pre-wrap break-all rounded-md border p-2 font-mono text-xs shadow">
          {sent}
        </pre>
      )}
    </div>
  )
}
