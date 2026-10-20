'use client'

/**
 * Step 1's „Projekt" card: what the create dialog took, to check at a glance.
 * Name, the address with the Gemeinde and Bundesland the geocoder named, the
 * status with its Zeitraum, and the short description. „Bearbeiten" opens the
 * address and the description in a sheet, so the card stays a card.
 *
 * Each value is edited where it lives. The address and the description are
 * profile facts, so „Ändern" writes them as the person's answers through the
 * review's decisions (`onDecide`, `patchProjectProfile`), the same door the
 * Rückfragen use; a hit chosen from the address search brings its Bundesland
 * and Land along. Name, status and period belong to the project and its
 * lifecycle (ADR-0098), so they link to the overview, where renaming, closing
 * and the Beginn already are.
 */

import { useMemo, useState, type FormEvent, type JSX } from 'react'
import Link from 'next/link'
import { Pencil } from 'lucide-react'
import { toast } from 'sonner'
import { AddressField, type AddressValue } from '@/components/projects/address-field'
import { BusyButton } from '@/components/ui/busy-button'
import { Button } from '@/components/ui/button'
import { Chip } from '@/components/ui/chip'
import { Field, FieldLabel } from '@/components/ui/field'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Textarea } from '@/components/ui/textarea'
import { useProjectPeriodText, useProjectRecordFormat } from '@/features/projects/components/project-record-editor'
import { useTranslations } from '@/i18n'
import { MAX_INTAKE_DESCRIPTION_LENGTH, type IntakeDecision, type IntakeView } from '@/lib/project-intake/types'
import type { ProjectBasics } from '@/lib/projects/participants-client'
import { createSameAddressClient, type SameAddressClient } from '@/lib/projects/same-address-client'
import type { ProjectRecordView } from '@/lib/projects/project-record-types'
import { ADDRESS_KEY, FEDERAL_STATE_KEY, COUNTRY_KEY, DESCRIPTION_KEY, dialogFacts } from './dialog-facts'
import { FactRow, StepCard } from './step-card'

export interface DialogFactsSectionProps {
  view: IntakeView
  projectId: string
  project: ProjectBasics | null
  peopleRecord: ProjectRecordView | null
  canDecide: boolean
  busy: boolean
  onDecide: (decisions: IntakeDecision[]) => Promise<boolean>
}

/** The decisions an edit makes: only what changed, a chosen hit with its Bundesland and Land. Pure. */
export function factDecisions(
  before: { address: string | null; description: string | null },
  after: { address: AddressValue; description: string }
): IntakeDecision[] {
  const decisions: IntakeDecision[] = []
  const address = after.address.text.trim()
  if (address && address !== before.address) {
    decisions.push({ key: ADDRESS_KEY, action: 'answer', value: address })
    const place = after.address.place
    if (place && place.label === address) {
      decisions.push({ key: COUNTRY_KEY, action: 'answer', value: place.country })
      if (place.federalState) decisions.push({ key: FEDERAL_STATE_KEY, action: 'answer', value: place.federalState })
    }
  }
  const description = after.description.trim()
  if (description && description !== (before.description ?? '')) {
    decisions.push({ key: DESCRIPTION_KEY, action: 'answer', value: description })
  }
  return decisions
}

/** The address search's same-address notice, without this project itself. */
function sameAddressExcept(projectId: string): SameAddressClient {
  const real = createSameAddressClient()
  return {
    async find(place, init) {
      const answer = await real.find(place, init)
      return { projects: answer.projects.filter((project) => project.id !== projectId) }
    },
  }
}

export function DialogFactsSection({ view, projectId, project, peopleRecord, canDecide, busy, onDecide }: DialogFactsSectionProps): JSX.Element {
  const t = useTranslations('intakeProjectStep')
  const facts = dialogFacts(view)
  const [editing, setEditing] = useState(false)
  const status = useStatusText(view, project, peopleRecord)
  // Wien is its own Bundesland: „Wien · Wien“ says nothing twice.
  const place = [...new Set([facts.municipality, facts.federalState].filter(Boolean))].join(' · ')

  return (
    <StepCard
      title={t('facts.label')}
      data-testid="project-step-facts"
      aside={
        canDecide ? (
          <Button type="button" variant="ghost" size="sm" className="touch-target -mr-2 h-[30px] gap-1.5 px-2 text-[13px] font-normal"
            aria-label={t('facts.editTitle')}
            onClick={() => setEditing(true)}
          >
            <Pencil aria-hidden />
            {t('facts.edit')}
          </Button>
        ) : undefined
      }
    >
      <dl>
        <FactRow label={t('facts.name')} data-testid="project-step-name">
          {project?.name ?? '–'}
        </FactRow>
        <FactRow label={t('facts.address')} data-testid="project-step-address">
          {facts.address ?? <span className="text-muted-foreground">{t('facts.addressMissing')}</span>}
          {place && (
            <span className="text-muted-foreground mt-0.5 flex flex-wrap items-center gap-1.5 text-xs" data-testid="project-step-place">
              {place}
              {facts.federalStateSuggested && (
                <Chip size="sm" variant="info">
                  {t('facts.suggested')}
                </Chip>
              )}
            </span>
          )}
        </FactRow>
        <FactRow label={t('facts.status')} data-testid="project-step-status">
          {status}
        </FactRow>
        <FactRow label={t('facts.description')} data-testid="project-step-description">
          {facts.description ?? <span className="text-muted-foreground">{t('facts.descriptionMissing')}</span>}
        </FactRow>
      </dl>

      <Sheet open={editing} onOpenChange={setEditing}>
        <SheetContent closeLabel={t('facts.cancel')} data-testid="project-step-facts-sheet">
          <SheetHeader>
            <SheetTitle>{t('facts.editTitle')}</SheetTitle>
            <SheetDescription>{t('facts.editDescription')}</SheetDescription>
          </SheetHeader>
          {editing && (
            <FactsForm
              projectId={projectId}
              address={facts.address}
              description={facts.description}
              busy={busy}
              onDecide={onDecide}
              onDone={() => setEditing(false)}
            />
          )}
          <p className="text-muted-foreground text-[13px]">
            {t('facts.nameAndStatus')}{' '}
            <Link href={`/app/projects/${encodeURIComponent(projectId)}`} className="text-foreground underline underline-offset-4">
              {t('facts.editInOverview')}
            </Link>
          </p>
        </SheetContent>
      </Sheet>
    </StepCard>
  )
}

/** „Aktiv · seit März 2026", „Fertiggestellt, wird nach der Prüfung abgeschlossen · März 2024 – Juni 2026". */
function useStatusText(view: IntakeView, project: ProjectBasics | null, peopleRecord: ProjectRecordView | null): string {
  const t = useTranslations('intakeProjectStep')
  const { span } = useProjectRecordFormat()
  const period = useProjectPeriodText(peopleRecord ?? { startedOn: null, endedOn: null })
  const closing = view.closing && project?.status !== 'closed' ? view.closing : null
  const label = closing ? t(`facts.closingIntent.${closing.outcome}`) : project ? t(`facts.statuses.${project.status}`) : null
  const when = closing ? span(closing.startedOn ?? null, closing.endedOn) : peopleRecord ? period : ''
  return [label, when].filter(Boolean).join(' · ') || '–'
}

function FactsForm({
  projectId,
  address,
  description,
  busy,
  onDecide,
  onDone,
}: {
  projectId: string
  address: string | null
  description: string | null
  busy: boolean
  onDecide: (decisions: IntakeDecision[]) => Promise<boolean>
  onDone: () => void
}): JSX.Element {
  const t = useTranslations('intakeProjectStep')
  const sameAddress = useMemo(() => sameAddressExcept(projectId), [projectId])
  const [addressValue, setAddressValue] = useState<AddressValue>({ text: address ?? '', place: null })
  const [text, setText] = useState(description ?? '')
  const [saving, setSaving] = useState(false)

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    if (saving || busy) return
    const decisions = factDecisions({ address, description }, { address: addressValue, description: text })
    if (decisions.length === 0) return onDone()
    setSaving(true)
    const ok = await onDecide(decisions)
    setSaving(false)
    if (!ok) return void toast.error(t('facts.saveFailed'))
    toast.success(t('facts.saved'))
    onDone()
  }

  return (
    <form className="space-y-4" onSubmit={(event) => void submit(event)} aria-label={t('facts.label')} data-testid="project-step-facts-form">
      <AddressField value={addressValue} onChange={setAddressValue} disabled={saving} sameAddressClient={sameAddress} />
      <Field>
        <FieldLabel htmlFor="project-step-description-input">{t('facts.descriptionLabel')}</FieldLabel>
        <Textarea
          id="project-step-description-input"
          rows={3}
          maxLength={MAX_INTAKE_DESCRIPTION_LENGTH}
          placeholder={t('facts.descriptionPlaceholder')}
          value={text}
          onChange={(event) => setText(event.target.value)}
        />
      </Field>
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button type="button" variant="ghost" onClick={onDone}>
          {t('facts.cancel')}
        </Button>
        <BusyButton type="submit" busy={saving} blocked={busy} busyLabel={t('facts.saving')}>
          {t('facts.save')}
        </BusyButton>
      </div>
    </form>
  )
}
