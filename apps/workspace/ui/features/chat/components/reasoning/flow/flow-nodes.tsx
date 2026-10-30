import { type FC, useId } from 'react'
import { ChevronDown, ChevronUp, Circle } from 'lucide-react'
import { FOCUS_RING, FOCUS_RING_INSET } from '@/components/ui/focus-ring'
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react'
import { useTranslations } from '@/i18n'
import { chatCopy } from '@/i18n/namespaces/chat'
import { cn } from '@/lib/utils'
import { RoundCalls } from '../WorkList'
import { type LinkSelection } from '../../../lib/work-list'
import { documentShortName } from '../../../lib/document-names'
import { BareSourceCard, FOLDER_TAB, RECEDED, SourceCard } from '../SourceCard'
import { CitationMarkers } from '../../CitationMarker'
import { SectionLabel } from '@/components/ui/section-label'
import {
  H,
  EDGE_STROKE,
  FramingData,
  SourceColumnData,
  ColumnSlot,
  FindingsData,
  RoundData,
} from './flow-node-data'

const Eyebrow: FC<{ children: React.ReactNode }> = ({ children }) => (
  <SectionLabel as="div">{children}</SectionLabel>
)

const FramingFlowNode: FC<NodeProps<Node<FramingData>>> = ({ data }) => (
  <div className="bg-card w-[var(--banner-w)] max-w-full rounded-surface border px-4 py-3 text-left shadow-xs">
    <Eyebrow>
      <span className="inline-flex items-center gap-1.5">{data.label}</span>
    </Eyebrow>
    <p className="text-foreground mt-1 text-sm leading-relaxed">{data.question}</p>
    {data.escalation && (
      <p className="text-warning mt-1.5 text-xs leading-relaxed">{data.escalation}</p>
    )}
    {data.sources.map((h) => (
      <Handle
        key={h.id}
        id={h.id}
        type="source"
        position={Position.Bottom}
        style={{ ...H, left: h.left }}
      />
    ))}
  </div>
)

/**
 * One checkpoint layer, and the control that folds the fan under it.
 *
 * The whole card is the target, because "the step" is what a reader points at —
 * so the control is a stretched overlay button rather than a chevron in the
 * corner. It carries its own `aria-label` (the card's body is a conclusion, not
 * a control name) and reports the state through `aria-expanded`, which is what
 * makes it keyboard-operable at all: React Flow is configured with
 * `nodesFocusable={false}` and `disableKeyboardA11y`, so a node is only ever
 * reachable through a real `<button>` inside it.
 *
 * There is deliberately no `aria-controls`: the fan is a SIBLING node in the
 * React Flow pane, not a descendant of this card, and its column elements carry
 * `data-id` rather than `id`. Pointing at an id that does not exist is worse
 * than pointing at nothing.
 */
const RoundFlowNode: FC<NodeProps<Node<RoundData>>> = ({ data }) => (
  <div className="bg-card relative w-[var(--banner-w)] max-w-full rounded-surface border px-4 pt-3 pb-2 text-left shadow-xs">
    {data.targets.map((h) => (
      <Handle
        key={h.id}
        id={h.id}
        type="target"
        position={Position.Top}
        style={{ ...H, left: h.left }}
      />
    ))}
    {data.foldable && (
      <button
        type="button"
        onClick={data.onToggle}
        aria-expanded={!data.folded}
        aria-label={data.toggleLabel}
        data-testid="reasoning-round-toggle"
        className={cn(
          'absolute inset-0 z-10 cursor-pointer rounded-surface outline-none',
          // Inset: the banner spans the content width, and an offset ring is
          // clipped by the pane on both sides.
          FOCUS_RING_INSET
        )}
      />
    )}
    <div className="flex items-start justify-between gap-2">
      <Eyebrow>
        {data.label} · {data.sub}
      </Eyebrow>
      {data.foldable && (
        <ChevronDown
          aria-hidden="true"
          className={cn(
            'text-muted-foreground duration-quick mt-px size-3.5 shrink-0 transition-transform ease-out motion-reduce:transition-none',
            data.folded && '-rotate-90'
          )}
        />
      )}
    </div>
    {/* The model's sentence, when it wrote one: it names the intent. A step
        without one loses nothing — its rows say what it did. */}
    {data.text ? <p className="text-foreground mt-1 text-sm leading-relaxed">{data.text}</p> : null}
    {/* A step stored before the action rows (ADR-0132) still names its tools. */}
    {!data.calls && data.actions.length > 0 ? (
      <ul className="mt-1.5 flex flex-wrap gap-1">
        {data.actions.map((action) => (
          <li
            key={action}
            className="bg-muted text-muted-foreground rounded-control px-1.5 py-0.5 text-[11px] leading-snug pointer-coarse:text-xs"
          >
            {action}
          </li>
        ))}
      </ul>
    ) : null}
    {data.calls ? (
      <RoundCalls
        round={data.calls}
        compact={data.compact}
        linking={data.linking}
        ruled={Boolean(data.text)}
      />
    ) : null}
    {/* Folded: the fan collapses to its scent — the count plus the top
        filename(s). Not the query (PF-12), and never a bare count: evidence
        hidden behind a number reads as no evidence. */}
    {data.foldable && data.folded ? (
      <p className="border-base text-muted-foreground mt-1.5 border-t pt-1.5 pb-1 text-xs leading-relaxed">
        {data.foldSummary}
      </p>
    ) : null}
    {data.sources.map((h) => (
      <Handle
        key={h.id}
        id={h.id}
        type="source"
        position={Position.Bottom}
        style={{ ...H, left: h.left }}
      />
    ))}
  </div>
)

/**
 * One fan-out column. Exactly two edges touch it — framing → column and
 * column → assessment — both centred, so the connector is always a straight
 * drop no matter how many cards the column carries. Stacked cards are joined by
 * a short hairline in the same ink as the edges, so the stack reads as "these
 * were searched together", not as a sequence of steps.
 */
const SourceColumnFlowNode: FC<NodeProps<Node<SourceColumnData>>> = ({ data }) => {
  const stack = (
    <div role="list" aria-label={data.groupLabel} className="flex w-full flex-col">
      {data.cards.map((slot, i) => (
        <div
          key={slot.type === 'card' ? slot.fan.key : `fold:${slot.key}`}
          className="flex flex-col"
        >
          {/* The hairline joins cards; the open fold is a text control under
              the last uncited card, not a card, and hangs on nothing. */}
          {i > 0 && !(slot.type === 'fold' && slot.expanded) && (
            <span
              aria-hidden="true"
              className="mx-auto h-2.5 w-px shrink-0"
              style={{ backgroundColor: EDGE_STROKE }}
            />
          )}
          {slot.type === 'fold' ? (
            <UncitedFoldCard slot={slot} onToggle={() => data.onToggleFold(slot.key)} />
          ) : (
            <FanSlotCard slot={slot} live={data.live} onSelect={data.onSelect} />
          )}
        </div>
      ))}
    </div>
  )

  return (
    <div
      className="max-w-full"
      style={{ width: data.colW !== undefined ? `${data.colW}px` : 'var(--source-w)' }}
    >
      <Handle
        id="in"
        type="target"
        position={Position.Top}
        style={{ ...H, left: '50%', top: data.inTop }}
      />
      {data.grouped ? (
        <div className="bg-muted rounded-surface border px-3 py-3">
          <Eyebrow>{data.groupLabel}</Eyebrow>
          <div className="mt-2">{stack}</div>
        </div>
      ) : (
        stack
      )}
      <Handle id="out" type="source" position={Position.Bottom} style={{ ...H, left: '50%' }} />
    </div>
  )
}

/**
 * One document of a fan. Tapping it (it opens its preview, as it always did)
 * also lights up the rows of the calls that returned it; a card no call names
 * (the prefetch's, or a turn stored before `call_id`) links to nothing.
 */
const FanSlotCard: FC<{
  slot: Extract<ColumnSlot, { type: 'card' }>
  live: boolean
  onSelect: (selection: LinkSelection | null) => void
}> = ({ slot, live, onSelect }) => {
  const { fan, callIds, link } = slot
  const select =
    callIds.length > 0
      ? () => onSelect(link === 'selected' ? null : { key: fan.key, callIds })
      : undefined
  return fan.card ? (
    <SourceCard
      document={fan.card}
      live={live}
      {...(fan.loci ? { loci: fan.loci } : {})}
      {...(link ? { link } : {})}
      {...(select ? { onSelect: select } : {})}
    />
  ) : (
    <BareSourceCard
      name={fan.workspace ? fan.name : documentShortName(fan.name, fan.title)}
      {...(fan.workspace ? { workspace: true } : {})}
      {...(fan.loci ? { loci: fan.loci } : {})}
    />
  )
}

/**
 * The round's uncited documents as one dashed card: „+2 abgerufen, nicht
 * zitiert“ with their names. While the answer runs nothing is cited yet, so it
 * reads „+2 weitere“. A button: it opens the folded cards in place.
 *
 * Open, it is no longer a card: the cards it held stand above it, and what
 * remains is the way back, a plain muted line under the last of them. The
 * button's name is what it shows (the count and the names, never a label that
 * hides them); the tab describes it.
 */
const UncitedFoldCard: FC<{
  slot: Extract<ColumnSlot, { type: 'fold' }>
  onToggle: () => void
}> = ({ slot, onToggle }) => {
  const t = useTranslations(chatCopy)
  const tabId = useId()
  const U = 'thinking.node.uncited.'
  if (slot.expanded) {
    return (
      <div role="listitem" data-testid="uncited-fold" className="mt-1.5 flex min-w-0">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded
          className={cn(
            'text-muted-foreground duration-snap pointer-fine:hover:text-foreground inline-flex min-h-8 items-center gap-1 rounded-control px-1 text-left text-[13px] leading-[19px] transition-[color,scale] ease-out outline-none active:scale-[0.985] motion-reduce:transition-none pointer-coarse:min-h-11',
            FOCUS_RING
          )}
        >
          <ChevronUp aria-hidden="true" className="size-3.5 shrink-0" />
          {t(`${U}hide`)}
        </button>
      </div>
    )
  }
  return (
    <div
      role="listitem"
      data-testid="uncited-fold"
      className={cn(
        'duration-quick flex min-w-0 flex-col transition-opacity ease-out motion-reduce:transition-none',
        slot.receded && RECEDED
      )}
    >
      {/* Card-white on the muted panel and the phone's muted box alike: the
          cited tabs carry their kind's tint, this one only its words. */}
      <SectionLabel id={tabId} className={cn(FOLDER_TAB, 'bg-card text-muted-foreground')}>
        {t(`${U}${slot.live ? 'pillLive' : 'pill'}`)}
      </SectionLabel>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={false}
        aria-describedby={tabId}
        className={cn(
          'bg-muted/40 duration-snap pointer-fine:hover:bg-muted flex min-h-11 w-full min-w-0 flex-col rounded-control border border-dashed px-3 py-2.5 text-left transition-[background-color,scale] ease-out outline-none active:scale-[0.985] motion-reduce:transition-none',
          FOCUS_RING
        )}
      >
        <span className="text-foreground/80 text-sm leading-5 font-medium">
          {t(`${U}${slot.live ? 'nameLive' : 'name'}`, { count: slot.count })}
        </span>
        <span className="text-muted-foreground line-clamp-2 text-[13px] leading-[19px] [overflow-wrap:break-word] hyphens-auto [hyphenate-limit-chars:10_4_4]">
          {slot.names.join(', ')}
        </span>
      </button>
    </div>
  )
}

const FindingsFlowNode: FC<NodeProps<Node<FindingsData>>> = ({ data }) => (
  <div
    className={cn(
      'bg-card w-[var(--banner-w)] max-w-full rounded-surface border px-4 py-3 text-left shadow-xs',
      // Pending reads as in-flight rather than as an empty result: dashed
      // hairline, no fill — the same visual grammar the uncited fold uses.
      data.pending && 'border-dashed bg-transparent shadow-none'
    )}
  >
    {data.targets.map((h) => (
      <Handle
        key={h.id}
        id={h.id}
        type="target"
        position={Position.Top}
        style={{ ...H, left: h.left }}
      />
    ))}
    <Eyebrow>{data.label}</Eyebrow>
    {data.pendingNote && (
      <p className="text-muted-foreground mt-1 text-sm leading-relaxed">{data.pendingNote}</p>
    )}
    {/* What the answer stands on, as two columns that become one on a phone:
        a label on the left, its lines on the right. „Offen“ sits on its own
        tinted band, with a ring for its shape — a gap, not an alarm. */}
    {data.basis.length > 0 && (
      <dl
        className={cn(
          'mt-2 grid gap-y-2 text-sm leading-[21px]',
          data.compact ? 'grid-cols-1' : 'grid-cols-[124px_minmax(0,1fr)] gap-x-3'
        )}
      >
        {data.basis.map((group) => (
          <div
            key={group.label}
            data-testid={group.open ? 'basis-open' : 'basis-group'}
            className={cn(
              'col-span-full grid grid-cols-subgrid gap-y-0.5',
              group.open && 'bg-muted -mx-3 mt-1 rounded-surface px-3 py-2.5'
            )}
          >
            <dt
              className={cn(
                data.compact && 'text-[13px] leading-[19px]',
                group.open
                  ? 'text-foreground inline-flex items-start gap-1.5 font-medium'
                  : 'text-muted-foreground'
              )}
            >
              {group.open && (
                <Circle aria-hidden strokeWidth={2.4} className="mt-[5px] size-3 shrink-0" />
              )}
              {group.label}
            </dt>
            <dd className="min-w-0 [overflow-wrap:anywhere]">
              {/* A cited line leads with the answer's own marker, so „1“
                  here peeks and opens what „1“ in the prose does. */}
              {group.lines.map((line) => (
                <p key={line.text}>
                  {line.numbers.length > 0 && (
                    <>
                      <CitationMarkers
                        numbers={line.numbers}
                        className="font-medium tabular-nums"
                      />{' '}
                    </>
                  )}
                  {line.text}
                </p>
              ))}
            </dd>
          </div>
        ))}
      </dl>
    )}
    {data.truncation && (
      // Same muted register as the lines above it: this is a fact about the
      // evidence, not a warning — the node is not tinted, bordered or
      // iconified for it, because "the search stopped" is not an error.
      <p className="border-base text-muted-foreground mt-1.5 border-t pt-1.5 text-xs leading-relaxed">
        {data.truncation.before}
        {data.truncation.step && (
          <span className={data.truncation.mono ? 'font-mono' : undefined}>
            {data.truncation.step}
          </span>
        )}
        {data.truncation.after}
      </p>
    )}
    {data.limits && (
      <div className="border-base mt-1.5 border-t pt-1.5">
        <Eyebrow>{data.limits.label}</Eyebrow>
        {data.limits.lines.map((line) => (
          <p
            key={line.text}
            className={cn(
              'mt-0.5 text-xs leading-relaxed',
              line.warn ? 'text-warning' : 'text-muted-foreground'
            )}
          >
            {line.text}
          </p>
        ))}
      </div>
    )}
    <Handle
      id={data.source.id}
      type="source"
      position={Position.Bottom}
      style={{ ...H, left: data.source.left }}
    />
  </div>
)

export const nodeTypes = {
  framing: FramingFlowNode,
  round: RoundFlowNode,
  sourceColumn: SourceColumnFlowNode,
  findings: FindingsFlowNode,
}
