'use client'

import type { JSX } from 'react'
import Link from 'next/link'
import { ExternalLink, MessageSquareText } from 'lucide-react'
import { Chip } from '@/components/ui/chip'
import { HoverPeekPanel } from '@/components/ui/hover-peek-panel'
import { useHoverPopover } from '@/hooks/use-hover-popover'
import { useLocale, useTranslations } from '@/i18n'
import { intakeProfileStepCopy } from '@/i18n/namespaces/intake-profile-step'
import { projectsCopy } from '@/i18n/namespaces/projects'
import type { ApplicableStatus } from '@/lib/oib/applicable-standards'
import type { IntakeView } from '@/lib/project-intake/types'
import { cn } from '@/lib/utils'
import { confirmedCount } from './profile-review'
import { byStatus, standardReasonId, standardShortId } from './standard-reasons'

type Standard = NonNullable<IntakeView['applicableStandards']>[number]

const STATUSES: readonly ApplicableStatus[] = ['required', 'likely', 'check']

/** The verdict as a dot: filled applies, a ring probably, a dashed ring to check. */
function StatusDot({ status }: { status: ApplicableStatus }): JSX.Element {
  return (
    <span
      aria-hidden
      className={cn(
        'border-primary inline-block size-[7px] shrink-0 rounded-full',
        status === 'required' && 'bg-primary',
        status === 'likely' && 'border-[1.5px]',
        status === 'check' && 'border-[1.5px] border-dashed',
      )}
    />
  )
}

/**
 * „Was für dieses Projekt gilt": the rule set's Ampel as one row of chips, an
 * OIB-Richtlinie each, its verdict in the dot. The verdicts are the server's
 * (`getApplicableStandards` over the confirmed values only), the same the
 * overview shows, so a suggestion changes them once someone takes it. Each chip
 * peeks why it applies, in the reader's language, with the Richtlinie and a
 * question to Piloti about it.
 */
export function RulesCard({ view }: { view: IntakeView }): JSX.Element | null {
  const t = useTranslations(intakeProfileStepCopy)
  const standards = view.applicableStandards
  if (!standards || standards.length === 0) return null
  const shown = byStatus(standards)
  const used = STATUSES.filter((status) => standards.some((standard) => standard.status === status))
  const confirmed = confirmedCount(view)
  return (
    <section
      aria-labelledby="profile-rules-heading"
      className="bg-card border-border min-w-0 rounded-[14px] border px-4 py-4 md:px-[22px] md:py-[18px]"
      data-testid="profile-rules"
    >
      <h2 id="profile-rules-heading" className="text-sm font-semibold">
        {t('rules.heading')}
      </h2>
      <ul className="mt-3 flex flex-wrap gap-2">
        {shown.map((standard) => (
          <li key={standard.code}>
            <RuleChip projectId={view.projectId} standard={standard} />
          </li>
        ))}
      </ul>
      <p className="text-muted-foreground mt-3 text-xs" data-testid="profile-rules-basis">
        {used.map((status) => t(`rules.legend.${status}`)).join(' · ')}.{' '}
        {confirmed === 0 ? t('rules.basisNone') : t('rules.basis', { count: confirmed })} {t('rules.disclaimer')}
      </p>
    </section>
  )
}

function RuleChip({ projectId, standard }: { projectId: string; standard: Standard }): JSX.Element {
  const t = useTranslations(intakeProfileStepCopy)
  const tProjects = useTranslations(projectsCopy)
  const { locale } = useLocale()
  const peek = useHoverPopover()
  const shortId = standardShortId(standard.code)
  const title = locale === 'de' ? standard.titleDe : standard.titleEn
  const name = shortId ? t(`rules.short.${shortId}`) : title
  const status = t(`rules.status.${standard.status}`)
  const reasonId = standardReasonId(standard.reason)
  const reason = reasonId ? t(`rules.reasons.${reasonId}`) : t(`rules.reasonFallback.${standard.status}`)
  const question = tProjects('applicableStandards.askQuestion', { code: standard.code, title })
  return (
    <>
      <Chip
        asChild
        interactive
        variant="outline"
        className="bg-card h-7 gap-1.5 rounded-lg px-2.5 text-[13px] font-normal pointer-coarse:h-9"
      >
        <button
          type="button"
          aria-label={t('rules.chipAria', { code: standard.code, name, status })}
          data-status={standard.status}
          data-testid={`profile-rule-${standard.code}`}
          {...peek.triggerProps}
        >
          <StatusDot status={standard.status} />
          <span>
            {standard.code} {name}
            {standard.status !== 'required' && <span className="text-muted-foreground">, {status}</span>}
          </span>
        </button>
      </Chip>
      <HoverPeekPanel peek={peek} className="w-72 space-y-2 p-3">
        <p className="text-sm font-medium">
          {standard.code} · {title}
        </p>
        <p className="flex items-center gap-1.5 text-xs">
          <StatusDot status={standard.status} />
          {status}
        </p>
        <p className="text-muted-foreground text-xs leading-relaxed">{reason}</p>
        <div className="flex flex-wrap gap-2 pt-1">
          {standard.oibUrl && (
            <Chip asChild interactive variant="outline" size="sm">
              <a href={standard.oibUrl} target="_blank" rel="noopener noreferrer">
                <ExternalLink aria-hidden />
                {t('rules.source')}
              </a>
            </Chip>
          )}
          <Chip asChild interactive variant="outline" size="sm">
            <Link href={`/app/projects/${projectId}/chat?ask=${encodeURIComponent(question)}`}>
              <MessageSquareText aria-hidden />
              {t('rules.ask')}
            </Link>
          </Chip>
        </div>
      </HoverPeekPanel>
    </>
  )
}
