/**
 * The Befundmatrix: one row per requirement the report read against the
 * project, over the prose and under the masthead.
 *
 * A planning office commissions a Prüfung, and the table every Gutachten
 * carries is this one: the requirement, the value, where it is written, and
 * whether it is met. The prose under it is the audit trail. The list is the
 * backend's (`message-findings.ts`); this renders it and nothing else.
 *
 * ON A PHONE the table is not a table. Four columns in a 320px column wrapped
 * "Fundstelle" to five lines and the status off to a sideways scroll, the two
 * cells a reader came for. Below 30rem of its OWN container (the answer column,
 * not the viewport) each row becomes a card: the requirement as the title, the
 * status right under it, then value and Fundstelle each under their column's
 * name. One DOM, two layouts: the same rows, the same click, the same tests.
 *
 * Colour never travels alone: every status carries its word, and the count
 * line above the table says the same in numbers. A row with a comment or a
 * reference opens on click; the `[N]` link jumps to the answer's own sources
 * row, the same anchor the prose markers use.
 */

import { useState, type FC } from 'react'
import { ChevronDown, CircleCheck, CircleHelp, CircleMinus, CircleX } from 'lucide-react'
import { Chip } from '@/components/ui/chip'
import { SectionLabel } from '@/components/ui/section-label'
import { useCurrentProject } from '@/features/projects/lib/current-project'
import { useTranslations } from '@/i18n'
import { chatCopy } from '@/i18n/namespaces/chat'
import type { Finding, Findings, FindingStatus } from '@/lib/conversations/message-findings'
import { findingCounts, hasFindingStatuses } from '@/lib/conversations/message-findings'
import { cn } from '@/lib/utils'

const STATUS_ICON: Record<FindingStatus, typeof CircleCheck> = {
  met: CircleCheck,
  not_met: CircleX,
  open: CircleHelp,
  not_applicable: CircleMinus,
}

const STATUS_VARIANT: Record<FindingStatus, 'success' | 'destructive' | 'warning' | 'muted'> = {
  met: 'success',
  not_met: 'destructive',
  open: 'warning',
  not_applicable: 'muted',
}

const referenceText = (
  finding: Finding,
  t: (key: string, values?: Record<string, string | number>) => string
) => {
  const reference = finding.reference
  if (!reference) return undefined
  const parts = [reference.document]
  if (reference.section) parts.push(reference.section)
  if (reference.page) parts.push(t('findings.page', { page: reference.page }))
  return parts.join(' · ')
}

/** How a row stands against the previous report's row of the same requirement. */
export type FindingChange = 'new' | 'changed' | 'same'

export function changeOf(finding: Finding, previous: Findings | undefined): FindingChange {
  if (!previous) return 'same'
  const before = previous.items.find((item) => item.requirement === finding.requirement)
  if (!before) return 'new'
  return (before.status ?? '') !== (finding.status ?? '') || (before.value ?? '') !== (finding.value ?? '')
    ? 'changed'
    : 'same'
}

/** Requirements the previous report had and this one dropped. */
export function droppedFrom(previous: Findings | undefined, current: Findings): string[] {
  if (!previous) return []
  const now = new Set(current.items.map((item) => item.requirement))
  return previous.items
    .map((item) => item.requirement)
    .filter((requirement) => !now.has(requirement))
}

/**
 * The stacked form's classes. Every one is spelled out in full because Tailwind
 * finds a class by scanning the source for it: a prefix concatenated at runtime
 * would ship no CSS. The variant is a container query on the matrix's own width
 * (`@container/matrix`), so a half-width desktop pane stacks as a phone does.
 */
const STACKED_CELL =
  '@max-[30rem]/matrix:flex @max-[30rem]/matrix:items-baseline @max-[30rem]/matrix:gap-3 @max-[30rem]/matrix:py-0 @max-[30rem]/matrix:pr-0 @max-[30rem]/matrix:before:w-[30%] @max-[30rem]/matrix:before:shrink-0 @max-[30rem]/matrix:before:text-xs @max-[30rem]/matrix:before:text-muted-foreground @max-[30rem]/matrix:before:content-[attr(data-label)]'

const OPEN_STATUSES: ReadonlySet<FindingStatus> = new Set(['open', 'not_met'])

const RequirementText: FC<{ finding: Finding; change: FindingChange }> = ({ finding, change }) => {
  const t = useTranslations(chatCopy)
  return (
    <span>
      {finding.requirement}
      {change !== 'same' && (
        <Chip size="sm" variant="info" className="ml-1.5 align-middle" data-testid="finding-change">
          {t(`findings.change.${change}`)}
        </Chip>
      )}
      {finding.area && <span className="text-muted-foreground block text-xs font-normal">{finding.area}</span>}
    </span>
  )
}

const FindingRow: FC<{
  finding: Finding
  anchorPrefix?: string
  change: FindingChange
  onCommission?: (finding: Finding) => Promise<boolean>
}> = ({ finding, anchorPrefix, change, onCommission }) => {
  const t = useTranslations(chatCopy)
  const [open, setOpen] = useState(false)
  const Icon = finding.status ? STATUS_ICON[finding.status] : null
  const reference = referenceText(finding, t)
  const [commissioned, setCommissioned] = useState(false)
  const expandable = Boolean(finding.comment)
  const clearable =
    Boolean(onCommission) &&
    finding.status !== undefined &&
    OPEN_STATUSES.has(finding.status) &&
    !commissioned
  return (
    <>
      <tr
        className={cn(
          'border-border/60 border-t align-top',
          '@max-[30rem]/matrix:flex @max-[30rem]/matrix:flex-col @max-[30rem]/matrix:gap-1.5 @max-[30rem]/matrix:rounded-surface @max-[30rem]/matrix:border @max-[30rem]/matrix:p-3',
          expandable && 'hover:bg-muted/40 cursor-pointer'
        )}
        onClick={expandable ? () => setOpen((value) => !value) : undefined}
        data-testid="finding-row"
        data-status={finding.status}
      >
        <td className={cn('text-foreground py-2 pr-3 text-sm', '@max-[30rem]/matrix:p-0 @max-[30rem]/matrix:font-medium')}>
          <span className="flex items-start gap-1.5">
            {expandable ? (
              // A real control: the row's own click is a pointer convenience, and
              // a row nobody could reach with a keyboard or a screen reader hid
              // the comment that says WHY a requirement is met or not.
              <button
                type="button"
                aria-expanded={open}
                className="focus-visible:ring-ring/60 flex min-h-0 w-full items-start gap-1.5 rounded-control text-left focus-visible:outline-none focus-visible:ring-2 pointer-coarse:min-h-11 pointer-coarse:items-center"
              >
                <ChevronDown
                  className={cn(
                    'text-muted-foreground mt-0.5 size-3.5 shrink-0 transition-transform duration-quick ease-out motion-reduce:transition-none pointer-coarse:mt-0',
                    open && 'rotate-180'
                  )}
                  aria-hidden="true"
                />
                <RequirementText finding={finding} change={change} />
              </button>
            ) : (
              <RequirementText finding={finding} change={change} />
            )}
          </span>
        </td>
        <td
          data-label={t('findings.columns.value')}
          className={cn('text-foreground py-2 pr-3 text-sm tabular-nums', STACKED_CELL, '@max-[30rem]/matrix:order-2')}
        >
          {finding.value ?? '–'}
        </td>
        <td
          data-label={t('findings.columns.reference')}
          className={cn('text-muted-foreground py-2 pr-3 text-xs', STACKED_CELL, '@max-[30rem]/matrix:order-3')}
        >
          <span className="min-w-0">
            {reference ?? '–'}
            {anchorPrefix &&
              finding.citations.map((number) => (
                <a
                  key={number}
                  href={`#${anchorPrefix}${number}`}
                  onClick={(event) => event.stopPropagation()}
                  className="text-brand ml-1 inline-flex items-center justify-center underline decoration-dotted underline-offset-2 pointer-coarse:min-h-11 pointer-coarse:min-w-8"
                  aria-label={t('answerSources.sourceNumber', { number })}
                >
                  [{number}]
                </a>
              ))}
          </span>
        </td>
        <td className={cn('py-2 text-xs', '@max-[30rem]/matrix:order-1 @max-[30rem]/matrix:p-0')}>
          <span className="flex flex-wrap items-center gap-1">
            {finding.status && Icon && (
              <Chip size="sm" variant={STATUS_VARIANT[finding.status]}>
                <Icon aria-hidden />
                {t(`findings.status.${finding.status}`)}
              </Chip>
            )}
            {finding.grounding !== 'sourced' && (
              <Chip size="sm" variant="outline">
                {t(`findings.grounding.${finding.grounding}`)}
              </Chip>
            )}
            {clearable && (
              <button
                type="button"
                data-testid="finding-commission"
                onClick={(event) => {
                  event.stopPropagation()
                  void onCommission?.(finding).then((ok) => setCommissioned(ok))
                }}
                className="rounded-control text-brand focus-visible:ring-ring/60 underline decoration-dotted underline-offset-2 hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 pointer-coarse:inline-flex pointer-coarse:min-h-11 pointer-coarse:items-center pointer-coarse:px-2"
              >
                {t('findings.clarify')}
              </button>
            )}
            {commissioned && (
              <Chip size="sm" variant="success" data-testid="finding-commissioned">
                {t('findings.commissioned')}
              </Chip>
            )}
          </span>
        </td>
      </tr>
      {open && finding.comment && (
        <tr className={cn('bg-muted/30', '@max-[30rem]/matrix:block @max-[30rem]/matrix:-mt-1 @max-[30rem]/matrix:rounded-surface')} data-testid="finding-detail">
          <td colSpan={4} className={cn('text-muted-foreground px-3 py-2 text-sm', '@max-[30rem]/matrix:block')}>
            {finding.comment}
          </td>
        </tr>
      )}
    </>
  )
}

export const FindingsMatrix: FC<{
  findings: Findings
  anchorPrefix?: string
  /** The previous report's findings on the same subject, for the change marks. */
  previous?: Findings
  /** Commission a run to clear an open finding; absent when the thread cannot. */
  onCommission?: (finding: Finding) => Promise<boolean>
}> = ({ findings, anchorPrefix, previous, onCommission }) => {
  const t = useTranslations(chatCopy)
  // A closed project commissions nothing (ADR-0090): the thread hides „Klären“, and this says why.
  const closedProject = useCurrentProject()?.status === 'closed'
  const openFindings = findings.items.some((finding) => finding.status !== undefined && OPEN_STATUSES.has(finding.status))
  const counts = findingCounts(findings)
  const dropped = droppedFrom(previous, findings)
  // Befunde when the report judged, Ergebnisse when it only stated: the same
  // table, the honest word for it, and no empty status column.
  const judged = hasFindingStatuses(findings)
  const label = judged ? t('findings.label') : t('findings.labelResults')
  const summary = (Object.keys(counts) as FindingStatus[])
    .filter((status) => counts[status] > 0)
    .map((status) => `${counts[status]} ${t(`findings.status.${status}`)}`)
    .join(' · ')
  return (
    <section
      className="@container/matrix flex flex-col gap-2"
      data-testid="findings-matrix"
      aria-label={label}
      data-judged={judged ? 'true' : 'false'}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <SectionLabel>{label}</SectionLabel>
        {judged && <span className="text-muted-foreground text-xs">{summary}</span>}
      </div>
      <div className="overflow-x-auto">
        <table className={cn('w-full border-collapse text-left', '@max-[30rem]/matrix:block')}>
          <thead className={'@max-[30rem]/matrix:sr-only'}>
            <tr className="text-muted-foreground text-xs">
              <th className="pb-1 pr-3 font-medium">{t('findings.columns.requirement')}</th>
              <th className="pb-1 pr-3 font-medium">{t('findings.columns.value')}</th>
              <th className="pb-1 pr-3 font-medium">{t('findings.columns.reference')}</th>
              <th className="pb-1 font-medium">
                {judged ? t('findings.columns.status') : t('findings.columns.note')}
              </th>
            </tr>
          </thead>
          <tbody className={'@max-[30rem]/matrix:flex @max-[30rem]/matrix:flex-col @max-[30rem]/matrix:gap-2'}>
            {findings.items.map((finding, index) => (
              <FindingRow
                key={`${index}-${finding.requirement}`}
                finding={finding}
                anchorPrefix={anchorPrefix}
                change={changeOf(finding, previous)}
                onCommission={onCommission}
              />
            ))}
          </tbody>
        </table>
      </div>
      {closedProject && openFindings && (
        <p className="text-muted-foreground text-xs" data-testid="findings-closed-project">
          {t('findings.clarifyClosed')}
        </p>
      )}
      {dropped.length > 0 && (
        <p className="text-muted-foreground text-xs" data-testid="findings-dropped">
          {t('findings.change.dropped', { count: dropped.length })} {dropped.join(' · ')}
        </p>
      )}
    </section>
  )
}
