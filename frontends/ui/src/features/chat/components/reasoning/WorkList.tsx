'use client'

/**
 * The calls of one Herleitung step (ADR-0131), inside its node of the graph:
 * one row per call — the verb muted, its object, what it found on the right.
 *
 * A status is a shape and a word, never a colour: a running call has a quiet
 * dot and „läuft“, a search that found nothing a ring and „kein Treffer“, a
 * failed call a triangle and „fehlgeschlagen“. Colour is kept for where a
 * source comes from, on the cards below.
 *
 * Tapping a row lights up the source cards its call returned and sets the
 * others back (`LinkSelection`, joined by `call_id`). A row stored before the
 * wire carried a call id links to nothing; when it names a document it opens
 * that document instead, as it always did. A look row carries its crop, marked
 * as read off rather than measured.
 */

import { useMemo, useState, type FC } from 'react'
import {
  BookOpen,
  Boxes,
  Circle,
  FolderOpen,
  FolderSearch,
  Globe,
  LayoutGrid,
  Scale,
  ScanSearch,
  Search,
  TriangleAlert,
  type LucideIcon,
} from 'lucide-react'
import { FOCUS_RING } from '@/components/ui/focus-ring'
import { PagePlaceDialog } from '@/features/knowledge/components/page-place-dialog'
import type { PagePlace } from '@/features/knowledge/lib/page-place'
import { useTranslations } from '@/i18n'
import { cn } from '@/lib/utils'
import type { ActionVerb, StoredAction } from '@/lib/conversations/message-provenance'
import { lookStepGroups } from '../../lib/look-steps'
import { isLinked, type LinkSelection, type WorkRound, type WorkRow } from '../../lib/work-list'
import { firstPage, workParts, workPartsText, type WorkParts } from '../../lib/work-sentence'
import { LookStepRow, LookStrip } from './LookStepRow'

const VERB_ICONS: Record<ActionVerb, LucideIcon> = {
  search: Search,
  list: FolderOpen,
  read: BookOpen,
  look: ScanSearch,
  lookup: FolderSearch,
  law: Scale,
  web: Globe,
  model: Boxes,
  workspace: LayoutGrid,
}

/**
 * The document a row opens, or null when it opens nothing: a row needs a
 * document it can address (a workspace id, or the corpus by name). A search
 * opens only when its hits are in one document, which is when the wire names it.
 */
export function placeOfAction(action: StoredAction): PagePlace | null {
  if (action.verb !== 'read' && action.verb !== 'look' && action.verb !== 'search') return null
  if (!action.target) return null
  const base = action.shelf === 'base'
  if (!base && !action.documentId) return null
  return {
    document: {
      id: base ? null : (action.documentId ?? null),
      name: action.target,
      shelf: base ? 'base' : 'stored',
    },
    page: firstPage(action.pages) ?? 1,
    frame: 'page',
    region: null,
  }
}

/** What links rows and cards: the round's selection and how to change it. */
export interface RowLinking {
  selection: LinkSelection | null
  onSelect: (selection: LinkSelection | null) => void
}

/** The result on the row's right edge (or its second line on a phone): shape + word. */
const ResultWord: FC<{ parts: WorkParts }> = ({ parts }) => {
  const t = useTranslations('chat')
  if (!parts.result) return null
  const strong = parts.tone === 'empty' || parts.tone === 'error'
  return (
    <span
      data-testid="work-row-result"
      className={cn(
        'inline-flex items-center gap-1.5 tabular-nums',
        strong || parts.tone === 'running' ? 'text-foreground' : 'text-muted-foreground',
        strong && 'font-semibold'
      )}
    >
      {parts.tone === 'running' && (
        <span
          aria-hidden
          className="bg-foreground animate-caret-breathe size-1.5 rounded-full motion-reduce:animate-none"
        />
      )}
      {parts.tone === 'empty' && (
        <Circle aria-hidden strokeWidth={2.4} className="size-3 shrink-0" />
      )}
      {parts.tone === 'error' && (
        <TriangleAlert aria-hidden strokeWidth={2.4} className="size-3 shrink-0" />
      )}
      {parts.result}
      {parts.tone === 'error' && (
        <span className="text-muted-foreground font-normal">{` · ${t('thinking.work.failedNote')}`}</span>
      )}
    </span>
  )
}

export const WorkRowView: FC<{
  row: WorkRow
  compact?: boolean
  linking?: RowLinking
  eager?: boolean
}> = ({ row, compact = false, linking, eager }) => {
  const t = useTranslations('chat')
  const [open, setOpen] = useState(false)
  const { action } = row
  const Icon = VERB_ICONS[action.verb]
  const look = row.looks[0]
  const parts = workParts(t, action, {
    running: row.running,
    ...(row.fold ? { fold: row.fold } : {}),
    ...(look?.where ? { where: look.where } : {}),
    ...(look?.reading ? { reading: look.reading } : {}),
  })
  const sentence = workPartsText(parts)
  const linkable = row.callIds.length > 0 && Boolean(linking)
  const place = linkable ? null : placeOfAction(action)
  const pressed = linkable && linking ? isLinked(linking.selection, row.callIds) : false
  const times = row.fold ? t('thinking.work.times', { count: row.fold.count }) : ''

  const text = (
    <span className="min-w-0 [overflow-wrap:anywhere] break-words">
      {parts.verb && <span className="text-muted-foreground">{parts.verb} </span>}
      <span className="text-foreground">{parts.object}</span>
      {times && <span className="text-muted-foreground tabular-nums">{` ${times}`}</span>}
    </span>
  )
  const body = (
    <>
      <Icon
        aria-hidden
        strokeWidth={1.8}
        className={cn('text-muted-foreground size-4 shrink-0', compact && 'mt-0.5')}
      />
      {compact ? (
        <span className="flex min-w-0 flex-col">
          {text}
          <ResultWord parts={parts} />
        </span>
      ) : (
        <>
          {text}
          <span className="justify-self-end whitespace-nowrap">
            <ResultWord parts={parts} />
          </span>
        </>
      )}
    </>
  )
  const lineClass = cn(
    '-mx-2 grid w-[calc(100%+1rem)] gap-x-2.5 rounded-lg px-2 text-left text-[13px] leading-[19px]',
    compact
      ? 'min-h-11 grid-cols-[16px_minmax(0,1fr)] items-start py-[7px]'
      : 'min-h-10 grid-cols-[16px_minmax(0,1fr)_auto] items-center py-2'
  )
  const interactive = cn(
    lineClass,
    'cursor-pointer outline-none transition-[background-color,scale] duration-snap ease-out active:scale-[0.985] motion-reduce:transition-none pointer-fine:hover:bg-muted/60',
    FOCUS_RING
  )
  const group =
    row.looks.length > 0
      ? { key: row.id, document: row.looks[0].place.document, looks: row.looks }
      : null

  return (
    <li
      data-testid="work-row"
      data-verb={action.verb}
      data-status={row.running ? 'running' : action.status}
      className="flex min-w-0 flex-col"
    >
      {linkable && linking ? (
        <button
          type="button"
          data-testid="work-row-link"
          aria-pressed={pressed}
          aria-label={sentence}
          onClick={() =>
            linking.onSelect(
              pressed && linking.selection?.key === row.id
                ? null
                : { key: row.id, callIds: row.callIds }
            )
          }
          className={cn(interactive, pressed && 'bg-muted')}
        >
          {body}
        </button>
      ) : place ? (
        <>
          <button
            type="button"
            data-testid="work-row-open"
            aria-label={t('thinking.work.open', { target: place.document.name })}
            onClick={() => setOpen(true)}
            className={interactive}
          >
            {body}
          </button>
          {open && <PagePlaceDialog place={place} open={open} onOpenChange={setOpen} />}
        </>
      ) : (
        <p aria-label={sentence} className={lineClass}>
          {body}
        </p>
      )}
      {group && !row.running && (
        <div
          className={cn(
            'mb-2 ml-[26px] flex gap-2.5',
            compact ? 'flex-col items-start' : 'items-end'
          )}
        >
          <LookStrip group={group} eager={eager} className="flex gap-2" />
          <span className="text-muted-foreground pb-0.5 text-[13px] leading-[19px]">
            {look?.where
              ? t('thinking.look.place', { page: look.place.page, where: look.where })
              : look
                ? t('thinking.look.placeWhole', { page: look.place.page })
                : ''}
            <br />
            {t('thinking.work.readOff')}
          </span>
        </div>
      )}
    </li>
  )
}

/**
 * The calls of one step, inside its node: a row per call, the worst first and
 * „+N weitere“ when a step made more than five, and the step's looks under
 * the row that made them. The rows sit above the node's fold overlay so they
 * stay clickable.
 */
export const RoundCalls: FC<{
  round: WorkRound
  compact?: boolean
  linking?: RowLinking
  eager?: boolean
}> = ({ round, compact, linking, eager }) => {
  const t = useTranslations('chat')
  const [showMore, setShowMore] = useState(false)
  const strays = useMemo(() => lookStepGroups(round.strayLooks), [round.strayLooks])
  const rows = showMore ? [...round.rows, ...round.more] : round.rows
  const allFound = round.more.every((row) => !row.running && row.action.status === 'ok')
  return (
    <ul
      data-testid="work-round"
      data-round={round.round}
      aria-label={t('thinking.work.label')}
      className="border-base relative z-20 mt-2 flex flex-col border-t pt-1"
    >
      {rows.map((row) => (
        <WorkRowView key={row.id} row={row} compact={compact} linking={linking} eager={eager} />
      ))}
      {round.more.length > 0 && (
        <li className="border-base flex border-t">
          <button
            type="button"
            data-testid="work-round-more"
            aria-expanded={showMore}
            onClick={() => setShowMore((value) => !value)}
            className={cn(
              'text-foreground pointer-fine:hover:bg-muted/60 -mx-2 flex min-h-10 w-[calc(100%+1rem)] items-center rounded-lg px-2 pl-[34px] text-left text-[13px] outline-none',
              FOCUS_RING
            )}
          >
            {showMore
              ? t('thinking.work.fewer')
              : t(allFound ? 'thinking.work.moreAllFound' : 'thinking.work.more', {
                  count: round.more.length,
                })}
          </button>
        </li>
      )}
      {strays.map((group) => (
        <LookStepRow key={group.key} group={group} eager={eager} />
      ))}
    </ul>
  )
}
