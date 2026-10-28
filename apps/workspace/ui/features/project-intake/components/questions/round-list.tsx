'use client'

import type { JSX, ReactNode } from 'react'
import { Check } from 'lucide-react'
import { useTranslations } from '@/i18n'
import { intakeQuestionsStepCopy } from '@/i18n/namespaces/intake-questions-step'
import { cn } from '@/lib/utils'
import { ROUND_GROUPS } from '../../lib/question-round'
import type { RoundRow } from './use-round-memory'

/** The marker before a row: done (filled, a check), asked now (a thick ring), open (a thin ring; amber for a contradiction). */
function Marker({ row, current }: { row: RoundRow; current: boolean }): JSX.Element {
  if (row.done) {
    return (
      <span aria-hidden className="bg-primary text-primary-foreground flex size-[18px] shrink-0 items-center justify-center rounded-full">
        <Check className="size-2.5" strokeWidth={4} />
      </span>
    )
  }
  return (
    <span
      aria-hidden
      className={cn(
        'size-[18px] shrink-0 rounded-full',
        current ? 'border-primary border-[5px]' : 'border-[1.5px]',
        !current && (row.group === 'contradiction' ? 'border-warning' : 'border-muted-foreground/50')
      )}
    />
  )
}

/**
 * Every Rückfrage of the round on the left, by group: „Fehlt in den
 * Unterlagen", „Unterlagen zum Standort", „Widerspruch". A done one shows what
 * was given; an open one is a button that brings it into the card. Desk only:
 * on a phone the question fills the screen and the bar carries the count.
 */
export function RoundList({
  rows,
  currentId,
  onChoose,
  note,
  footer,
}: {
  rows: readonly RoundRow[]
  currentId: string | null
  onChoose: (id: string) => void
  /** One quiet line under the subtitle (Piloti still reads, a past project). */
  note?: ReactNode
  /** Under the list: the folded interview's link. */
  footer?: ReactNode
}): JSX.Element {
  const t = useTranslations(intakeQuestionsStepCopy)
  const tStatus = (row: RoundRow, current: boolean): string =>
    row.done ? t('list.done') : current ? t('list.current') : t('list.open')
  return (
    <aside aria-labelledby="questions-list-title" className="hidden w-[280px] shrink-0 md:block" data-testid="questions-list">
      <h1 id="questions-list-title" className="ml-2.5 text-xl font-semibold tracking-tight">
        {t('heading')}
      </h1>
      <p className="text-muted-foreground ml-2.5 mt-1 text-[13px]">{t('subtitle')}</p>
      {note && <div className="text-muted-foreground ml-2.5 mt-2 text-[13px] leading-snug">{note}</div>}
      {ROUND_GROUPS.map((group) => {
        const inGroup = rows.filter((row) => row.group === group)
        if (inGroup.length === 0) return null
        return (
          <section key={group} aria-labelledby={`questions-group-${group}`} data-testid={`questions-group-${group}`}>
            <h2
              id={`questions-group-${group}`}
              className="text-muted-foreground mb-1.5 ml-2.5 mt-[18px] text-[11px] font-normal uppercase tracking-[0.06em]"
            >
              {t(`groups.${group}`)}
            </h2>
            <ul>
              {inGroup.map((row) => {
                const current = row.id === currentId
                const body = (
                  <>
                    <Marker row={row} current={current} />
                    <span className={cn('min-w-0 flex-1 truncate', row.done && 'text-muted-foreground')}>{row.label}</span>
                    {row.value && (
                      <span className="text-muted-foreground max-w-[45%] shrink-0 truncate text-[13px]">{row.value}</span>
                    )}
                    <span className="sr-only">{tStatus(row, current)}</span>
                  </>
                )
                const rowClass = 'flex w-full items-center gap-2.5 rounded-[9px] px-2.5 py-[9px] text-left text-sm'
                return (
                  <li key={row.id} title={row.label}>
                    {row.done ? (
                      <div className={rowClass}>{body}</div>
                    ) : (
                      <button
                        type="button"
                        aria-current={current ? 'true' : undefined}
                        onClick={() => onChoose(row.id)}
                        className={cn(
                          rowClass,
                          'focus-visible:ring-ring/60 hover:bg-card/70 focus-visible:outline-none focus-visible:ring-2',
                          current && 'bg-card ring-border ring-1 hover:bg-card'
                        )}
                      >
                        {body}
                      </button>
                    )}
                  </li>
                )
              })}
            </ul>
          </section>
        )
      })}
      {footer && <div className="ml-2.5 mt-5">{footer}</div>}
    </aside>
  )
}
