'use client'

import type { JSX } from 'react'
import { useState } from 'react'
import Link from 'next/link'
import { Check, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { useTranslations } from '@/i18n'
import type { DerivationReview, IntakeDecision, Suggestion, SuggestionGroup } from '@/lib/project-intake/types'
import { cn } from '@/lib/utils'
import { usePressed } from '../../hooks/use-pressed'
import { buildingNumber } from '../../lib/display'
import { SourcePeek } from './source-peek'
import { EditValue } from './edit-value'
import { findings, restByTopic, shortLabel, topFindings } from './profile-review'

interface Decide {
  canDecide: boolean
  busy: boolean
  onDecide: (decisions: IntakeDecision[]) => Promise<boolean>
}

/** The table's columns on a desk; on a phone each row is a stacked list item. */
const ROW_GRID = 'md:grid md:grid-cols-[200px_minmax(0,1fr)_200px_148px] md:items-center md:gap-3.5'

/**
 * „Was Piloti gefunden hat": one table of the values the reading found, each
 * with the place it stands. The few that decide the most are shown (the inputs
 * of the Gebäudeklasse first); the rest fold away by topic behind one link.
 * The person checks rather than approves: they change what is wrong, and the
 * footer's „Alles übernehmen und abschließen“ takes the rest, each value as
 * their confirmation with its evidence.
 */
export function FindingsCard({
  projectId,
  groups,
  derivations,
  reading,
  editable,
  ...decide
}: Decide & {
  projectId: string
  groups: readonly SuggestionGroup[]
  derivations: readonly DerivationReview[]
  /** A reading is running: more rows are on their way. */
  reading: boolean
  /** The briefing editor is still a way to change the values (the setup is not finished). */
  editable: boolean
}): JSX.Element {
  const t = useTranslations('intakeProfileStep')
  const [open, setOpen] = useState(false)
  const all = findings(groups)
  const top = topFindings(groups, derivations)
  const rest = restByTopic(groups, top)
  const confirmed = all.filter((item) => item.state === 'confirmed').length
  const severalBuildings = new Set(all.map((item) => item.bauwerkId).filter(Boolean)).size > 1
  const restCount = rest.reduce((sum, group) => sum + group.items.length, 0)

  return (
    <section
      aria-labelledby="profile-findings-heading"
      className="bg-card border-border rounded-[14px] border"
      data-testid="profile-findings"
    >
      <Collapsible open={open} onOpenChange={setOpen}>
        <header className="flex flex-col gap-1 px-4 pb-1.5 pt-4 md:flex-row md:items-start md:justify-between md:gap-6 md:px-[18px]">
          <div className="min-w-0">
            <h2 id="profile-findings-heading" className="text-base font-semibold">
              {t('findings.heading')}
            </h2>
            <p className="text-muted-foreground mt-0.5 text-[13px]">
              {reading ? t('findings.reading') : t('findings.description')}
            </p>
          </div>
          {all.length > 0 && (
            <p className="text-muted-foreground shrink-0 text-[13px] tabular-nums" data-testid="profile-findings-counts">
              {t('findings.counts', { total: all.length, confirmed })}
            </p>
          )}
        </header>

        {all.length === 0 ? (
          <p className="text-muted-foreground border-border border-t px-4 py-6 text-sm md:px-[18px]">{t('findings.empty')}</p>
        ) : (
          <>
            <div
              aria-hidden
              className={cn(
                ROW_GRID,
                'text-muted-foreground hidden px-[18px] pb-2 pt-3.5 text-[11px] uppercase tracking-[0.06em]',
              )}
            >
              <span>{t('findings.columns.label')}</span>
              <span>{t('findings.columns.value')}</span>
              <span>{t('findings.columns.source')}</span>
              <span />
            </div>
            <FindingRows items={top} severalBuildings={severalBuildings} testId="profile-findings-top" {...decide} />
            <CollapsibleContent data-testid="profile-findings-rest">
              {rest.map((group) => (
                <div key={group.stage} data-testid={`profile-topic-${group.stage}`}>
                  <h3 className="text-muted-foreground border-border border-t px-4 pb-2 pt-3.5 text-[11px] uppercase tracking-[0.06em] md:px-[18px]">
                    {group.title}
                  </h3>
                  <FindingRows items={group.items} severalBuildings={severalBuildings} {...decide} />
                </div>
              ))}
            </CollapsibleContent>
          </>
        )}

        {(restCount > 0 || editable) && (
          <footer className="border-border flex flex-col gap-2 border-t px-4 py-3 md:flex-row md:items-center md:justify-between md:px-[18px]">
            {restCount > 0 ? (
              <CollapsibleTrigger asChild>
                <Button type="button" variant="inline" className="touch-target self-start text-[13px]">
                  {open ? t('findings.showLess') : t('findings.showAll', { count: all.length })}
                </Button>
              </CollapsibleTrigger>
            ) : (
              <span />
            )}
            <div className="flex flex-col gap-2 md:flex-row md:items-center md:gap-4">
              {editable && (
                <Link
                  href={`/app/projects/${encodeURIComponent(projectId)}/intake`}
                  aria-label={t('findings.editorAria')}
                  className="text-muted-foreground hover:text-foreground flex touch-target items-center text-[13px] underline-offset-4 hover:underline"
                >
                  {t('findings.editor')}
                </Link>
              )}
            </div>
          </footer>
        )}
      </Collapsible>
    </section>
  )
}

function FindingRows({
  items,
  severalBuildings,
  testId,
  ...decide
}: Decide & { items: readonly Suggestion[]; severalBuildings: boolean; testId?: string }): JSX.Element {
  return (
    <ul data-testid={testId}>
      {items.map((item) => (
        <FindingRow key={item.key} item={item} severalBuildings={severalBuildings} {...decide} />
      ))}
    </ul>
  )
}

function FindingRow({ item, severalBuildings, ...decide }: Decide & { item: Suggestion; severalBuildings: boolean }): JSX.Element {
  const t = useTranslations('intakeProfileStep')
  const label = shortLabel(item.label)
  const building =
    severalBuildings && item.bauwerkId ? t('findings.building', { number: buildingNumber(item.bauwerkId) }) : null
  return (
    <li
      className={cn(
        ROW_GRID,
        'border-border/60 grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 border-t px-4 py-3 md:h-[46px] md:px-[18px] md:py-0',
      )}
      data-testid={`profile-finding-${item.key}`}
      data-state={item.state}
    >
      <span className="text-muted-foreground col-span-2 min-w-0 truncate text-[13px] md:col-span-1" title={item.label}>
        {label}
        {building && <span className="text-muted-foreground/80"> · {building}</span>}
      </span>
      <span className="min-w-0 truncate text-[15px] font-medium md:text-sm" title={item.display}>
        {item.display}
      </span>
      <span className="col-span-2 flex min-w-0 items-center md:col-span-1">
        <SourcePeek evidence={item.evidence} label={label} />
      </span>
      <span className="col-start-2 row-start-2 flex justify-end md:col-start-auto md:row-start-auto">
        <RowAction item={item} label={label} {...decide} />
      </span>
    </li>
  )
}

/**
 * What a row offers. Nothing to approve: what is right is taken with
 * „Alles übernehmen und abschließen“. A person changes what is wrong
 * („Ändern“) or says it is not right at all (✕); a value they set says so.
 */
function RowAction({ item, label, canDecide, busy, onDecide }: Decide & { item: Suggestion; label: string }): JSX.Element {
  const t = useTranslations('intakeProfileStep')
  const [dismissing, dismiss] = usePressed()
  if (item.state === 'confirmed') {
    return (
      <span className="text-success flex items-center gap-1.5 justify-self-end text-xs">
        <Check className="size-3" strokeWidth={3} aria-hidden />
        {t('findings.byYou')}
      </span>
    )
  }
  if (!canDecide) {
    return <span className="text-muted-foreground justify-self-end text-xs">{t('findings.suggestion')}</span>
  }
  return (
    <span className="flex items-center gap-1 justify-self-end">
      <EditValue item={item} label={label} busy={busy} onDecide={onDecide} />
      <Button
        type="button"
        size="icon"
        variant="ghost"
        className="text-muted-foreground size-[30px] pointer-coarse:size-11"
        aria-disabled={busy || dismissing || undefined}
        aria-busy={dismissing || undefined}
        aria-label={t('findings.dismissAria', { value: item.display, label })}
        title={t('findings.dismiss')}
        onClick={() => {
          if (busy || dismissing) return
          dismiss(() => onDecide([{ key: item.key, action: 'dismiss' }]))
        }}
      >
        <X aria-hidden />
      </Button>
    </span>
  )
}
