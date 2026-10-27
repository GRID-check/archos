'use client'

/**
 * WorkReportCard — „Arbeitsstand", the closing block of an operations turn
 * (`kind: work`, ADR-0123).
 *
 * A work turn is not an answer to a question: Piloti read the workspace,
 * proposed changes the person accepts, met something it could not do, and
 * knows what comes next. Before this block all of that was scattered over a
 * proposal card per write and a paragraph of prose, and the reader had to
 * assemble it. The block names it in four fixed sections, each one present
 * only when the turn has something for it, in the order the reader acts on:
 * what waits for them first, then what is blocked, then what is next, and
 * what was done last.
 *
 * Flat only: it is a field of the answer, drawn on the answer surface like the
 * takeaways, never in card chrome, and it has no state of its own. A proposal
 * line does not decide anything; its card does (ADR-0105), so the line is text.
 */

import type { FC } from 'react'
import { SectionLabel } from '@/components/ui/section-label'
import { useTranslations } from '@/i18n'
import type { AnswerMetaWorkItem } from '@/lib/conversations/message-answer-meta'

interface WorkReportCardProps {
  done?: AnswerMetaWorkItem[]
  proposed?: AnswerMetaWorkItem[]
  blocked?: AnswerMetaWorkItem[]
  next?: AnswerMetaWorkItem[]
}

/** The order the reader acts in: their decisions first. */
const ORDER = ['proposed', 'blocked', 'next', 'done'] as const

const WorkLine: FC<{ item: AnswerMetaWorkItem }> = ({ item }) => {
  const t = useTranslations('chat')
  const meta = [
    item.who ? t('cards.workReport.who', { who: item.who }) : null,
    item.due ? t('cards.workReport.due', { due: item.due }) : null,
  ].filter((part): part is string => Boolean(part))
  return (
    <li className="card-body text-pretty text-foreground">
      {item.text}
      {meta.length > 0 && <span className="card-caption text-muted-foreground"> · {meta.join(' · ')}</span>}
    </li>
  )
}

export const WorkReportCard: FC<WorkReportCardProps> = (props) => {
  const t = useTranslations('chat')
  const sections = ORDER.map((section) => ({ section, items: (props[section] ?? []).filter((item) => item?.text) })).filter(
    ({ items }) => items.length > 0
  )
  if (sections.length === 0) return null
  return (
    <section className="flex flex-col gap-3 rounded-lg bg-muted/40 px-4 py-3" aria-label={t('cards.workReport.eyebrow')}>
      <SectionLabel as="h3">{t('cards.workReport.eyebrow')}</SectionLabel>
      {sections.map(({ section, items }) => (
        <div key={section} className="flex flex-col gap-1" data-testid={`work-report-${section}`}>
          <SectionLabel as="h4">{t(`cards.workReport.${section}`)}</SectionLabel>
          <ul className="flex list-disc flex-col gap-1 pl-4">
            {items.map((item, index) => (
              <WorkLine key={`${item.text}-${index}`} item={item} />
            ))}
          </ul>
        </div>
      ))}
    </section>
  )
}
