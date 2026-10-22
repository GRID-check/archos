'use client'

/**
 * The Herleitung's work list (ADR-0131), under the source graph: the rounds of
 * the turn, and in each round one row per call. A row is its verb's icon, the
 * sentence (what was looked for, where, what it found), the call's time, and a
 * thin bar on the round's shared axis, so calls that ran together visibly
 * overlap. A call still running has its row from the moment it started; its
 * bar breathes (never under reduced motion) until it settles.
 *
 * A row about one document opens that document at its page (the look
 * thumbnails' dialog). A folder listing is not clickable: the wire names the
 * folder by its path in words, and the Files pane opens a folder by id.
 */

import { useMemo, useState, type FC } from 'react'
import {
  BookOpen,
  Boxes,
  FolderOpen,
  FolderSearch,
  Globe,
  LayoutGrid,
  Scale,
  ScanSearch,
  Search,
  type LucideIcon,
} from 'lucide-react'
import { FOCUS_RING } from '@/components/ui/focus-ring'
import { PagePlaceDialog } from '@/features/knowledge/components/page-place-dialog'
import type { PagePlace } from '@/features/knowledge/lib/page-place'
import { useLocale, useTranslations } from '@/i18n'
import { cn } from '@/lib/utils'
import type {
  ActionVerb,
  StoredAction,
} from '@/lib/conversations/message-provenance'
import { lookStepGroups } from '../../lib/look-steps'
import { formatWorkDuration, type WorkRound, type WorkRow } from '../../lib/work-list'
import { firstPage, workSentence } from '../../lib/work-sentence'
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

export const WorkRowView: FC<{ row: WorkRow; eager?: boolean }> = ({ row, eager }) => {
  const t = useTranslations('chat')
  const { locale } = useLocale()
  const [open, setOpen] = useState(false)
  const { action } = row
  const Icon = VERB_ICONS[action.verb]
  const sentence = workSentence(t, action)
  const place = placeOfAction(action)
  const failed = sentence.tone === 'error'
  const duration = row.running
    ? t('thinking.work.running')
    : action.elapsedMs === undefined
      ? ''
      : formatWorkDuration(action.elapsedMs, locale)
  const body = (
    <>
      <Icon
        aria-hidden
        className={cn('mt-px size-3.5 shrink-0', failed ? 'text-error' : 'text-muted-foreground')}
      />
      <span className="min-w-0 flex-1 break-words">
        <span className="text-foreground font-medium">{sentence.head}</span>
        {sentence.outcome && (
          <span
            className={failed ? 'text-error' : 'text-muted-foreground'}
          >{` · ${sentence.outcome}`}</span>
        )}
      </span>
      {duration && <span className="text-muted-foreground shrink-0 tabular-nums">{duration}</span>}
    </>
  )
  const lineClass = 'flex w-full min-w-0 items-start gap-1.5 text-left text-xs'
  const group =
    row.looks.length > 0
      ? { key: row.id, document: row.looks[0].place.document, looks: row.looks }
      : null
  return (
    <li
      data-testid="work-row"
      data-verb={action.verb}
      data-status={row.running ? 'running' : action.status}
      className="flex min-w-0 flex-col gap-1"
    >
      {place ? (
        <>
          <button
            type="button"
            data-testid="work-row-open"
            aria-label={t('thinking.work.open', { target: place.document.name })}
            onClick={() => setOpen(true)}
            className={cn(
              lineClass,
              'hover:bg-muted/60 duration-snap -mx-1 rounded-md px-1 py-0.5 transition-colors ease-out motion-reduce:transition-none',
              FOCUS_RING,
              'outline-none'
            )}
          >
            {body}
          </button>
          {open && <PagePlaceDialog place={place} open={open} onOpenChange={setOpen} />}
        </>
      ) : (
        <p className={lineClass}>{body}</p>
      )}
      <div aria-hidden className="bg-secondary relative ml-5 h-[3px] overflow-hidden rounded-full">
        <span
          data-testid="work-bar"
          style={{ left: `${row.leftPercent}%`, width: `${row.widthPercent}%` }}
          className={cn(
            'absolute inset-y-0 rounded-full',
            failed ? 'bg-error/60' : 'bg-brand/50',
            row.running && 'animate-caret-breathe motion-reduce:animate-none'
          )}
        />
      </div>
      {group && <LookStrip group={group} eager={eager} />}
    </li>
  )
}

/**
 * The meta of a round's header, after „Schritt n · Suche“: „3 gleichzeitig · 2,4 s“.
 * The count only when more than one call ran; the time only once every call ended.
 */
export const RoundMeta: FC<{ round: WorkRound }> = ({ round }) => {
  const t = useTranslations('chat')
  const { locale } = useLocale()
  const parts = [
    ...(round.rows.length > 1 ? [t('thinking.work.parallel', { count: round.rows.length })] : []),
    ...(round.durationMs === null ? [] : [formatWorkDuration(round.durationMs, locale)]),
  ]
  if (parts.length === 0) return null
  return <span data-testid="work-round-meta">{` · ${parts.join(' · ')}`}</span>
}

/**
 * The calls of one round, inside its node of the graph: a row per call, bars on
 * the round's shared time axis, and the looks of the round under the row that
 * made them. The rows sit above the node's fold overlay so they stay clickable.
 */
export const RoundCalls: FC<{ round: WorkRound; eager?: boolean }> = ({ round, eager }) => {
  const t = useTranslations('chat')
  const strays = useMemo(() => lookStepGroups(round.strayLooks), [round.strayLooks])
  return (
    <ul
      data-testid="work-round"
      data-round={round.round}
      aria-label={t('thinking.work.label')}
      className="relative z-20 mt-2 flex flex-col gap-2.5 border-t border-base pt-2"
    >
      {round.rows.map((row) => (
        <WorkRowView key={row.id} row={row} eager={eager} />
      ))}
      {strays.map((group) => (
        <LookStepRow key={group.key} group={group} eager={eager} />
      ))}
    </ul>
  )
}
