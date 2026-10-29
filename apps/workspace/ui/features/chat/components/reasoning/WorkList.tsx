'use client'

/**
 * The calls of one Herleitung step (ADR-0132), inside its node of the graph:
 * one row per call — the verb muted, its object, what it found on the right.
 *
 * A status is a shape and a word, never a colour: a running call has a quiet
 * dot and „läuft“, a search that found nothing a ring and „kein Treffer“, a
 * call the turn ended under a hollow dot and „abgebrochen“, a failed call a
 * triangle and „fehlgeschlagen“, with what that means for the answer on a
 * second line under the object; a literal search that could not search
 * everything a dashed ring and „unvollständig“, with its own second line (a
 * count that is a floor, a no that is no no). Colour is kept for where a
 * source comes from, on the cards below.
 *
 * Tapping a row lights up the source cards its call returned and sets the
 * others back (`LinkSelection`, joined by `call_id`). Only a row whose call
 * returned a card links: a listing, a name search or a literal search for
 * files is an index and returns none, and a tap that dims every card and
 * lights nothing is a control without an effect. A row stored before the wire
 * carried a call id links to nothing; when it names a document it opens that
 * document instead, as it always did. A look row carries its crop, marked
 * as read off rather than measured; while the look runs, a quiet box of the
 * crop's size holds its place, so settling does not move the rows below.
 */

import { useMemo, useState, type FC } from 'react'
import {
  BookOpen,
  Boxes,
  ChevronDown,
  Circle,
  CircleDashed,
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
import { chatCopy } from '@/i18n/namespaces/chat'
import { cn } from '@/lib/utils'
import type { ActionVerb, StoredAction } from '@/lib/conversations/message-provenance'
import { lookStepGroups } from '../../lib/look-steps'
import {
  isLinked,
  lookGroupRow,
  type LinkSelection,
  type WorkRound,
  type WorkRow,
} from '../../lib/work-list'
import { firstPage, workParts, workPartsText, type WorkParts } from '../../lib/work-sentence'
import { LookStrip, STRIP_MAX_HEIGHT, STRIP_WIDTH } from './LookStrip'

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
  /**
   * The calls that returned a card. A row links only when one of its calls is
   * here; absent, every row with a call id links (a caller without cards).
   */
  carded?: ReadonlySet<string>
  /**
   * The name the turn's card gives the document a call named, when there is
   * one: the row then says what the card and „Offen“ say („OIB-Richtlinie 2,
   * Ausgabe Mai 2023“, never „OIB-RL 2, Ausgabe 2023“ beside it).
   */
  nameOf?: (target: string) => string | undefined
}

/** The shape before a result word, inline with the text so a wrapped result keeps it. */
const ICON_INLINE = 'mr-1.5 inline-block align-[-2px]'

/** The result on the row's right edge (or its second line on a phone): shape + word. */
const ResultWord: FC<{ parts: WorkParts }> = ({ parts }) => {
  if (!parts.result) return null
  const strong = parts.tone === 'empty' || parts.tone === 'error' || parts.tone === 'incomplete'
  return (
    <span
      data-testid="work-row-result"
      className={cn(
        'tabular-nums',
        strong || parts.tone === 'running' ? 'text-foreground' : 'text-muted-foreground',
        strong && 'font-medium'
      )}
    >
      {parts.tone === 'running' && (
        <span
          aria-hidden
          className={cn(
            ICON_INLINE,
            'bg-foreground animate-caret-breathe size-1.5 rounded-full align-[1px] motion-reduce:animate-none'
          )}
        />
      )}
      {parts.tone === 'interrupted' && (
        <span
          aria-hidden
          className={cn(ICON_INLINE, 'border-muted-foreground size-1.5 rounded-full border align-[1px]')}
        />
      )}
      {parts.tone === 'empty' && (
        <Circle aria-hidden strokeWidth={2.4} className={cn(ICON_INLINE, 'size-3')} />
      )}
      {parts.tone === 'error' && (
        <TriangleAlert aria-hidden strokeWidth={2.4} className={cn(ICON_INLINE, 'size-3')} />
      )}
      {parts.tone === 'incomplete' && (
        <CircleDashed aria-hidden strokeWidth={2.4} className={cn(ICON_INLINE, 'size-3')} />
      )}
      {parts.result}
    </span>
  )
}

/** What a failed or incomplete call means for the answer, on its own muted line under the object. */
const ResultNote: FC<{ parts: WorkParts }> = ({ parts }) => {
  if (!parts.note) return null
  return (
    <span
      data-testid={parts.tone === 'error' ? 'work-row-failed-note' : 'work-row-note'}
      className="text-muted-foreground block"
    >
      {parts.note}
    </span>
  )
}

export const WorkRowView: FC<{
  row: WorkRow
  compact?: boolean
  linking?: RowLinking
  eager?: boolean
}> = ({ row, compact = false, linking, eager }) => {
  const t = useTranslations(chatCopy)
  const [open, setOpen] = useState(false)
  const { action } = row
  const Icon = VERB_ICONS[action.verb]
  const look = row.looks[0]
  const named = action.target ? linking?.nameOf?.(action.target) : undefined
  const parts = workParts(t, named ? { ...action, target: named } : action, {
    running: row.running,
    ...(row.fold ? { fold: row.fold } : {}),
    ...(look?.where ? { where: look.where } : {}),
    ...(look?.reading ? { reading: look.reading } : {}),
  })
  const sentence = workPartsText(parts)
  const linkable =
    Boolean(linking) && row.callIds.some((id) => (linking?.carded ? linking.carded.has(id) : true))
  const place = linkable ? null : placeOfAction(action)
  const pressed = linkable && linking ? isLinked(linking.selection, row.callIds) : false
  const times = row.fold ? t('thinking.work.times', { count: row.fold.count }) : ''

  const text = (
    <span className="min-w-0 [overflow-wrap:anywhere] break-words">
      {parts.verb && <span className="text-muted-foreground">{parts.verb} </span>}
      <span className="text-foreground">{parts.object}</span>
      {times && <span className="text-muted-foreground tabular-nums">{`\u00A0${times}`}</span>}
      {!compact && <ResultNote parts={parts} />}
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
          <ResultNote parts={parts} />
        </span>
      ) : (
        <>
          {text}
          <span className="justify-self-end text-right">
            <ResultWord parts={parts} />
          </span>
        </>
      )}
    </>
  )
  const lineClass = cn(
    '-mx-2 grid w-[calc(100%+1rem)] gap-x-2.5 rounded-control px-2 text-left text-[13px] leading-[19px]',
    compact
      ? 'min-h-11 grid-cols-[16px_minmax(0,1fr)] items-start py-[7px]'
      : 'min-h-10 grid-cols-[16px_minmax(0,1fr)_auto] items-center py-2 pointer-coarse:min-h-11'
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
      data-status={parts.tone === 'interrupted' ? 'interrupted' : row.running ? 'running' : action.status}
      data-incomplete={action.incomplete ? true : undefined}
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
            aria-label={t('thinking.work.open', { target: sentence })}
            onClick={() => setOpen(true)}
            className={interactive}
          >
            {body}
          </button>
          {open && <PagePlaceDialog place={place} open={open} onOpenChange={setOpen} />}
        </>
      ) : (
        <p className={lineClass}>{body}</p>
      )}
      {group && !row.running && (
        <div
          className={cn(
            'mb-2 ml-[26px] flex gap-2.5',
            compact ? 'flex-col items-start' : 'items-end'
          )}
        >
          <LookStrip group={group} eager={eager} className="flex gap-2" />
          {/* The row already says where; the caption says only what a crop is not. */}
          <span className="text-muted-foreground pb-0.5 text-[13px] leading-[19px]">
            {t('thinking.work.readOff')}
          </span>
        </div>
      )}
      {action.verb === 'look' && row.running && (
        <div className="mb-2 ml-[26px]">
          <div
            aria-hidden
            data-testid="work-row-look-skeleton"
            className="bg-muted max-w-full rounded-control"
            style={{ width: STRIP_WIDTH, height: STRIP_MAX_HEIGHT }}
          />
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
  /**
   * A rule above the rows, parting them from the step's sentence. Off for a
   * step without one: the node's own top edge already parts it, and a rule
   * there draws a double line.
   */
  ruled?: boolean
}> = ({ round, compact, linking, eager, ruled = true }) => {
  const t = useTranslations(chatCopy)
  const [showMore, setShowMore] = useState(false)
  const strays = useMemo(() => lookStepGroups(round.strayLooks), [round.strayLooks])
  const rows = showMore ? [...round.rows, ...round.more] : round.rows
  const allFound = round.more.every((row) => !row.running && row.action.status === 'ok')
  return (
    <ul
      data-testid="work-round"
      data-round={round.round}
      aria-label={t('thinking.work.label')}
      className={cn(
        'relative z-20 flex flex-col',
        ruled ? 'border-base mt-2 border-t pt-1' : 'mt-1'
      )}
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
              'group text-muted-foreground pointer-fine:hover:text-foreground pointer-fine:hover:bg-muted/60 duration-snap -mx-2 flex min-h-10 w-[calc(100%+1rem)] items-center gap-2.5 rounded-control px-2 text-left text-[13px] outline-none transition-[color,background-color,scale] ease-out active:scale-[0.985] motion-reduce:transition-none pointer-coarse:min-h-11',
              FOCUS_RING
            )}
          >
            <ChevronDown
              aria-hidden
              strokeWidth={1.8}
              className={cn(
                'duration-quick size-4 shrink-0 transition-transform ease-out motion-reduce:transition-none',
                showMore && 'rotate-180'
              )}
            />
            {showMore
              ? t('thinking.work.fewer')
              : t(allFound ? 'thinking.work.moreAllFound' : 'thinking.work.more', {
                  count: round.more.length,
                })}
          </button>
        </li>
      )}
      {strays.map((group) => (
        <WorkRowView
          key={group.key}
          row={lookGroupRow(group)}
          compact={compact}
          linking={linking}
          eager={eager}
        />
      ))}
    </ul>
  )
}
