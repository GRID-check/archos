'use client'

/**
 * The setup page (Projekterfassung) drawn from fixtures, so every state can be
 * looked at and screenshotted without a database, a worker or a reading:
 * `?state=waiting | reading | failed | ready | closing | completed` (default `ready`),
 * and `?busy=1` for a call in flight. The document chips open a PDF built from the
 * fixtures' own quotes, in the viewer the chat's citations use.
 *
 * Decisions call back into the page, which shows the last payload it was given
 * instead of changing the fixture: what a button sends is the thing to review.
 * Uploads go nowhere here.
 */

import { use, useState } from 'react'
import { ProjectSectionHeader } from './section-header'
import {
  INTAKE_FIXTURES,
  type IntakeFixtureName,
} from '@/app/dev/_fixtures/project-intake'
import { installFixtureDocuments } from './fixture-documents'
import { IntakeSetupView } from '@/features/project-intake/components/intake-setup-view'
import type { IntakeDecision } from '@/lib/project-intake/types'

installFixtureDocuments(INTAKE_FIXTURES.ready)

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
  const view = INTAKE_FIXTURES[name]
  const [sent, setSent] = useState<string | null>(null)

  return (
    <main className="bg-background min-h-dvh" data-testid="project-setup-preview">
      <ProjectSectionHeader state={name} />
      <IntakeSetupView
        view={view}
        projectId={view.projectId}
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
      />
      {sent && (
        <pre className="text-muted-foreground mx-auto max-w-5xl px-4 pb-8 font-mono text-xs break-all whitespace-pre-wrap md:px-8">
          {sent}
        </pre>
      )}
    </main>
  )
}
