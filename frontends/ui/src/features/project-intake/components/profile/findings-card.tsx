'use client'

import type { JSX } from 'react'
import { useState } from 'react'
import Link from 'next/link'
import { Check, X } from 'lucide-react'
import { BusyButton } from '@/components/ui/busy-button'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { useTranslations } from '@/i18n'
import type { DerivationReview, IntakeDecision, Suggestion, SuggestionGroup } from '@/lib/project-intake/types'
import { cn } from '@/lib/utils'
import { usePressed } from '../../hooks/use-pressed'
import { bauwerkNumber } from '../../lib/display'
import { SourcePeek } from './source-peek'
import { findings, restByTopic, shortLabel, takeAllDecisions, topFindings } from './steckbrief'

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
 * of the Gebäudeklasse first); the rest fold away by topic behind one link, and
 * every open one can be taken at once. A value is a suggestion until someone
 * takes it („Vorschlagen, nicht setzen“); one already taken says so.
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
  const tIntake = useTranslations('projectIntake')
  const [open, setOpen] = useState(false)
  const [taking, take] = usePressed()
  const all = findings(groups)
  const top = topFindings(groups, derivations)
  const rest = restByTopic(groups, top)
  const confirmed = all.filter((item) => item.state === 'confirmed').length
  const takeAll = takeAllDecisions(groups)
  const severalBauwerke = new Set(all.map((item) => item.bauwerkId).filter(Boolean)).size > 1
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
            <FindingRows items={top} severalBauwerke={severalBauwerke} testId="profile-findings-top" {...decide} />
            <CollapsibleContent data-testid="profile-findings-rest">
              {rest.map((group) => (
                <div key={group.stage} data-testid={`profile-topic-${group.stage}`}>
                  <h3 className="text-muted-foreground border-border border-t px-4 pb-2 pt-3.5 text-[11px] uppercase tracking-[0.06em] md:px-[18px]">
                    {group.title}
                  </h3>
                  <FindingRows items={group.items} severalBauwerke={severalBauwerke} {...decide} />
                </div>
              ))}
            </CollapsibleContent>
          </>
        )}

        {(restCount > 0 || editable || (decide.canDecide && takeAll.length > 0)) && (
          <footer className="border-border flex flex-col gap-2 border-t px-4 py-3 md:flex-row md:items-center md:justify-between md:px-[18px]">
            {restCount > 0 ? (
              <CollapsibleTrigger asChild>
                <Button type="button" variant="inline" className="min-h-11 self-start text-[13px] md:min-h-0">
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
                  className="text-muted-foreground hover:text-foreground flex min-h-11 items-center text-[13px] underline-offset-4 hover:underline md:min-h-0"
                >
                  {t('findings.editor')}
                </Link>
              )}
              {decide.canDecide && takeAll.length > 0 && (
                <BusyButton
                  type="button"
                  variant="outline"
                  size="sm"
                  className="bg-card text-[13px]"
                  busy={taking}
                  blocked={decide.busy}
                  busyLabel={tIntake('busy.confirm')}
                  onClick={() => take(() => decide.onDecide(takeAll))}
                >
                  {t('findings.takeAll', { count: takeAll.length })}
                </BusyButton>
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
  severalBauwerke,
  testId,
  ...decide
}: Decide & { items: readonly Suggestion[]; severalBauwerke: boolean; testId?: string }): JSX.Element {
  return (
    <ul data-testid={testId}>
      {items.map((item) => (
        <FindingRow key={item.key} item={item} severalBauwerke={severalBauwerke} {...decide} />
      ))}
    </ul>
  )
}

function FindingRow({ item, severalBauwerke, ...decide }: Decide & { item: Suggestion; severalBauwerke: boolean }): JSX.Element {
  const t = useTranslations('intakeProfileStep')
  const label = shortLabel(item.label)
  const bauwerk =
    severalBauwerke && item.bauwerkId ? t('findings.bauwerk', { number: bauwerkNumber(item.bauwerkId) }) : null
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
        {bauwerk && <span className="text-muted-foreground/80"> · {bauwerk}</span>}
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

/** Take or discard a suggestion; a value already taken says who took it. */
function RowAction({ item, label, canDecide, busy, onDecide }: Decide & { item: Suggestion; label: string }): JSX.Element {
  const t = useTranslations('intakeProfileStep')
  const tIntake = useTranslations('projectIntake')
  const [taking, take] = usePressed()
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
      <BusyButton
        type="button"
        size="sm"
        variant="outline"
        className="bg-card h-[30px] px-2.5 text-[13px]"
        busy={taking}
        blocked={busy}
        busyLabel={tIntake('busy.confirm')}
        aria-label={t('findings.takeAria', { value: item.display, label })}
        onClick={() => take(() => onDecide([{ key: item.key, action: 'confirm' }]))}
      >
        {t('findings.take')}
      </BusyButton>
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
