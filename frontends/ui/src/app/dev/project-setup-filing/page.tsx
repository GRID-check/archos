'use client'

/**
 * Dev preview of the setup's step 2, Ablage (ticket 26), drawn from fixtures:
 *
 *   `?state=empty`    — a new project: choose the project folder.
 *   `?state=chosen`   — „Wohnbau Nord" as a tree before the upload: backup, temp
 *                       and „_alt" proposed out, the fee folder held back by
 *                       the office's list, the top folders with who opens them.
 *   `?state=changed`  — the same, for a project that set „Vertrag" aside.
 *   `?state=readonly` — the same, for a member who does not manage the project.
 *   `?state=uploaded` — after the upload: the folders with their access, and
 *                       Piloti's two open filing suggestions.
 *
 * Nothing leaves the browser: a fake client answers the list and the folders,
 * the faked proposals API answers the suggestions, and „Hochladen" shows the
 * files it would hand to the upload instead of uploading them. Not linked from
 * anywhere; the `/dev` layout 404s it outside development.
 */

import { use, useMemo, useState } from 'react'
import { PageHeader } from '@/components/ui/page-header'
import { useFakeProposalClient } from '@/app/dev/_fixtures/fake-proposals'
import { INTAKE_FILING, INTAKE_READY, INTAKE_WAITING } from '@/app/dev/_fixtures/project-intake'
import {
  FILING_FOLDERS_UPLOADED,
  FILING_PROJECT_FOLDER,
  FILING_SCREENING,
  FILING_SCREENING_CHANGED,
  FILING_SCREENING_READONLY,
  fakeFilingClient,
} from '@/app/dev/_fixtures/project-setup-filing'
import { useFilingSuggestions } from '@/features/documents/hooks/use-filing-suggestions'
import { FilingStep } from '@/features/project-intake/components/steps/filing-step'

const STATES = ['empty', 'chosen', 'changed', 'readonly', 'uploaded'] as const
type State = (typeof STATES)[number]

function stateOf(value: string | string[] | undefined): State {
  const name = Array.isArray(value) ? value[0] : value
  return (STATES as readonly string[]).includes(name ?? '') ? (name as State) : 'chosen'
}

export default function ProjectSetupFilingPreviewPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const state = stateOf(use(searchParams).state)
  const uploaded = state === 'uploaded'
  const view = uploaded ? INTAKE_READY : INTAKE_WAITING
  const client = useMemo(
    () =>
      fakeFilingClient(
        state === 'changed' ? FILING_SCREENING_CHANGED : state === 'readonly' ? FILING_SCREENING_READONLY : FILING_SCREENING,
        uploaded ? FILING_FOLDERS_UPLOADED : []
      ),
    [state, uploaded]
  )
  const [sent, setSent] = useState<string | null>(null)
  const proposalsReady = useFakeProposalClient(INTAKE_FILING)
  const filing = useFilingSuggestions({
    query: proposalsReady && uploaded ? { projectId: view.projectId } : null,
    watching: false,
  })

  return (
    <main className="bg-background min-h-dvh" data-testid="project-setup-filing-preview">
      <div className="border-border border-b px-4 py-4 md:px-8">
        <PageHeader
          title="Projekterfassung · Ablage"
          action={<span className="text-muted-foreground font-mono text-xs">/dev/project-setup-filing?state={state}</span>}
        />
      </div>
      <div className="mx-auto w-full max-w-3xl px-4 py-8 md:px-8">
        <FilingStep
          key={state}
          view={view}
          projectId={view.projectId}
          busy={false}
          canDecide
          canUpload
          uploading={false}
          onDecide={async () => true}
          onFiles={(files) => setSent(`onFiles: ${files.length} files\n${files.map((file) => file.webkitRelativePath || file.name).join('\n')}`)}
          onReread={() => undefined}
          onNext={() => setSent('onNext')}
          onGoTo={(step) => setSent(`onGoTo: ${step}`)}
          filing={uploaded ? { entries: filing.byFolder, onSettled: filing.reload } : undefined}
          client={client}
          initialChoice={state === 'empty' || uploaded ? undefined : FILING_PROJECT_FOLDER}
        />
        {sent && (
          <pre className="text-muted-foreground mt-8 font-mono text-xs break-all whitespace-pre-wrap">{sent}</pre>
        )}
      </div>
    </main>
  )
}
