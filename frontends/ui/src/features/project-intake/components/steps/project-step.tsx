'use client'

import { useState, type JSX } from 'react'
import { ArrowRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslations } from '@/i18n'
import { createParticipantsClient, type ParticipantsClient } from '@/lib/projects/participants-client'
import { DialogFactsSection } from '../project/dialog-facts-section'
import { ParticipantsSection } from '../project/participants-section'
import { useParticipants } from '../project/use-participants'
import type { SetupStepProps } from './types'

export interface ProjectStepProps extends SetupStepProps {
  /** The Beteiligte's routes; the real ones unless a spec or the `/dev` preview brings its own. */
  client?: ParticipantsClient
}

/**
 * Step 1, Projekt (ticket 26, `docs/design/project-setup-five-steps.md`): what
 * the create dialog took, to check, and the Beteiligte.
 *
 * The dialog already asked for name, status, address and a line about the
 * project in under a minute, so this step asks nothing again: it shows those
 * values, each editable or linked to where it is edited, and adds the people.
 * Colleagues get a role in Piloti, everyone else a Funktion on the Steckbrief
 * (ADR-0091, ADR-0101), which is the one record of people; this step keeps no
 * second one. Everything is optional and „Weiter zur Ablage" is always there:
 * the creator is already on the project.
 */
export function ProjectStep({ view, projectId, busy, canDecide, onDecide, onNext, client: given }: ProjectStepProps): JSX.Element {
  const t = useTranslations('intakeProjectStep')
  const [client] = useState(() => given ?? createParticipantsClient())
  const participants = useParticipants(projectId, client)

  return (
    <div className="space-y-8" data-testid="setup-step-project">
      <DialogFactsSection
        view={view}
        projectId={projectId}
        project={participants.project}
        steckbrief={participants.steckbrief}
        canDecide={canDecide}
        busy={busy}
        onDecide={onDecide}
      />
      <ParticipantsSection
        projectId={projectId}
        client={client}
        steckbrief={participants.steckbrief}
        roster={participants.roster}
        loading={participants.loading}
        reload={participants.reload}
      />
      {onNext && (
        <nav className="border-border flex flex-wrap items-center justify-end gap-3 border-t pt-5" data-testid="project-step-nav">
          <p className="text-muted-foreground hidden text-xs sm:block">{t('nextHint')}</p>
          <Button type="button" onClick={onNext}>
            {t('next')}
            <ArrowRight aria-hidden />
          </Button>
        </nav>
      )}
    </div>
  )
}
