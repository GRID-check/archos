'use client'

import { useId, useState, type FC } from 'react'
import {
  Brain,
  BrainCog,
  CircleHelp,
  FileText,
  Gavel,
  Lock,
  Sparkles,
  Star,
  type LucideIcon,
} from 'lucide-react'
import { Chip, ChipCount } from '@/components/ui/chip'
import {
  NoteEmphasis,
  NoteList,
  NoteMeta,
  NotePanelHint,
  NotePanelTitle,
  NoteReplaced,
  NoteRow,
} from '@/components/ui/note-list'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useTranslations } from '@/i18n'
import { cn } from '@/lib/utils'
import type { TurnMemoryItem } from '../lib/turn-memory'

interface MemoryNotedChipProps {
  /**
   * What was recorded during THIS TURN — derived from the message itself by
   * `turnMemoryItems`, not fetched. Computed by the answer that owns the footer
   * because the answer also needs to know whether any exist to decide whether
   * the meta row renders at all.
   *
   * It used to be the whole conversation's memory, polled per rendered answer,
   * so after turn five turn one's answer also read „Piloti hat sich 5 gemerkt".
   */
  items: TurnMemoryItem[]
}

const KIND_META: Record<string, { icon: LucideIcon; labelKey: string }> = {
  decision: { icon: Gavel, labelKey: 'memory.kinds.decision' },
  constraint: { icon: Lock, labelKey: 'memory.kinds.constraint' },
  open_question: { icon: CircleHelp, labelKey: 'memory.kinds.open_question' },
  derived_fact: { icon: FileText, labelKey: 'memory.kinds.derived_fact' },
  preference: { icon: Star, labelKey: 'memory.kinds.preference' },
}

/**
 * „Piloti hat sich gemerkt · N" — what this ONE TURN made durable, on the
 * answer's own meta row, never behind the details disclosure: a write to the
 * project's memory changes what every later answer starts from, and a reader
 * who has to open „Details" to learn that it happened has not been told.
 *
 * The leading agent UIs settled on the same shape (ChatGPT's „Memory updated",
 * Claude's memory indicator): one quiet inline marker on the turn, one tap to
 * see what was written. A banner would outrank the answer it annotates.
 *
 * Two states, by what the turn did:
 * - **added** (Brain, „Piloti hat sich gemerkt"): only new notes.
 * - **updated** (BrainCog, „Gedächtnis aktualisiert"): at least one note
 *   REPLACED an earlier one (`supersedes`). The more important event, because
 *   something the reader may have relied on is gone, so it gets its own label
 *   and glyph, its corrections are listed first, and each one quotes the note
 *   it retired.
 *
 * The in-turn `remember` writes and the post-answer reflection stage's are
 * labelled apart because they are different promises. Renders nothing until
 * at least one item exists. The chip is `interactive`, so its catchment is
 * 44px (`touch-target`) while the pill stays chip-sized.
 */
export const MemoryNotedChip: FC<MemoryNotedChipProps> = ({ items }) => {
  const t = useTranslations('chat')
  const titleId = useId()
  const hintId = useId()
  // The reflection stage lands seconds after the answer settled. A chip that
  // arrives in front of the reader fades in (opacity only: it takes its room
  // in a row that is already on screen); one that was there when the answer
  // mounted, a reloaded thread, simply is.
  const [presentAtMount] = useState(items.length > 0)

  if (items.length === 0) return null

  /** In-turn `remember` vs the async reflection stage. */
  const provenanceLabel = (provenance: string): string =>
    provenance === 'distillation'
      ? t('memory.provenance.distillation')
      : t('memory.provenance.inTurn')

  const corrected = items.filter((item) => item.supersedes)
  const updated = corrected.length > 0
  // Corrections first: they are what the reader most needs to check.
  const ordered = updated ? [...corrected, ...items.filter((item) => !item.supersedes)] : items
  const ChipIcon = updated ? BrainCog : Brain

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Chip
          asChild
          variant="info"
          size="sm"
          interactive
          className={cn(!presentAtMount && 'animate-in fade-in-0 duration-base ease-out motion-reduce:animate-none')}
          data-testid="memory-chip"
          data-state-kind={updated ? 'updated' : 'added'}
          aria-label={
            updated
              ? t('memory.updatedAria', { count: items.length, corrected: corrected.length })
              : t('memory.notedAria', { count: items.length })
          }
        >
          <button type="button">
            <ChipIcon aria-hidden="true" />
            {updated ? t('memory.updated') : t('memory.noted')}
            <ChipCount count={items.length} />
          </button>
        </Chip>
      </PopoverTrigger>
      {/* Radix gives the panel the dialog role; it is named by its title line. */}
      <PopoverContent
        align="start"
        collisionPadding={12}
        className="w-80 max-w-[calc(100vw-24px)] p-0"
        aria-labelledby={titleId}
        aria-describedby={hintId}
      >
        <NotePanelTitle icon={ChipIcon} id={titleId}>
          {updated ? t('memory.updatedInMemory') : t('memory.addedToMemory')}
        </NotePanelTitle>
        <NoteList>
          {ordered.map((item) => {
            const meta = KIND_META[item.kind]
            const label = meta ? t(meta.labelKey) : item.kind
            return (
              <NoteRow
                key={item.id}
                icon={meta?.icon ?? FileText}
                data-testid="memory-item"
                meta={
                  <>
                    <NoteMeta
                      parts={[
                        ...(item.supersedes ? [<NoteEmphasis key="corrected">{t('memory.correctedLabel')}</NoteEmphasis>] : []),
                        label,
                        <>
                          {item.provenance === 'distillation' && <Sparkles className="size-3" aria-hidden="true" />}
                          {provenanceLabel(item.provenance)}
                        </>,
                      ]}
                    />
                    {item.supersedes ? (
                      <NoteReplaced label={t('memory.replaced')} data-testid="memory-item-supersedes">
                        {item.supersedes}
                      </NoteReplaced>
                    ) : null}
                  </>
                }
              >
                {item.content}
              </NoteRow>
            )
          })}
        </NoteList>
        <NotePanelHint id={hintId}>{t('memory.manageHint')}</NotePanelHint>
      </PopoverContent>
    </Popover>
  )
}
