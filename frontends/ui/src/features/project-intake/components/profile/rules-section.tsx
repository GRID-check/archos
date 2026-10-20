'use client'

import type { JSX } from 'react'
import { ApplicableStandards } from '@/features/projects/components/applicable-standards'
import { useTranslations } from '@/i18n'
import type { IntakeView } from '@/lib/project-intake/types'
import { IntakeSection } from '../intake-atoms'

/** The values a person has confirmed: what the rule set is computed from. The class counts once per Bauwerk. */
export function confirmedCount(view: Pick<IntakeView, 'groups' | 'derivations'>): number {
  const values = view.groups.flatMap((group) => group.items).filter((item) => item.state === 'confirmed').length
  const classes = view.derivations.filter((derivation) => derivation.suggestion?.state === 'confirmed').length
  return values + classes
}

/** A Bauwerk has a class to take that nobody took yet. */
export function classPending(view: Pick<IntakeView, 'derivations'>): boolean {
  return view.derivations.some((derivation) => derivation.value !== null && derivation.suggestion?.state === 'suggested')
}

/**
 * Die Regelwerks-Ampel (ticket 26): which OIB-Richtlinien apply, required,
 * likely or to check. It is the overview's own panel
 * (`features/projects/components/applicable-standards.tsx`) with the verdicts
 * the server computed from the confirmed values (`getApplicableStandards`), so
 * the setup and the overview cannot disagree. A line above it says what it was
 * computed from, and that a suggestion does not count until it is taken.
 */
export function RulesSection({ view }: { view: IntakeView }): JSX.Element | null {
  const t = useTranslations('intakeProfileStep')
  const standards = view.applicableStandards
  if (!standards) return null
  const confirmed = confirmedCount(view)
  return (
    <IntakeSection label={t('rules.heading')} description={t('rules.description')} testId="profile-rules">
      <div className="space-y-1 text-sm" data-testid="profile-rules-basis">
        <p>{confirmed === 0 ? t('rules.basisNone') : t('rules.basis', { count: confirmed })}</p>
        {classPending(view) && <p className="text-muted-foreground">{t('rules.classPending')}</p>}
      </div>
      <ApplicableStandards projectId={view.projectId} standards={standards} briefComplete />
    </IntakeSection>
  )
}
