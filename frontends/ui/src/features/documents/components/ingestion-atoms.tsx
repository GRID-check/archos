'use client'

import type { JSX, ReactNode } from 'react'
import {
  ArrowUp,
  Ban,
  Check,
  CircleAlert,
  CircleDashed,
  CircleHelp,
  Clock,
  ScanText,
  ShieldAlert,
  type LucideIcon,
} from 'lucide-react'
import type { SurfaceState } from '@/lib/documents/surface-state'
import { cn } from '@/lib/utils'
import type { UploadPhase } from '../lib/upload-progress'

/**
 * The material every ingestion surface draws a document's state with: the
 * upload tray's rows, the status badge on a card and in the list, the preview.
 *
 * The badge used to be a coloured word and the tray row a coloured word, so the
 * states that share a colour were told apart by reading: „Wartet" and „Wird
 * gelesen" were the same blue pill, „Wartet", „Abgebrochen" and „Abgelegt" the
 * same grey word. The design language asks for icon + label + colour on every
 * signal, and it is the glyph that separates states which share a colour, at a
 * glance and without colour vision. One table, so a card and the tray row for
 * the same file cannot pick different glyphs.
 *
 * No glyph here moves. A reading document is the common case on a shelf that
 * just took a batch, and thirty spinning marks are texture, not a signal; the
 * tray's header carries the batch's one loop.
 */

/** Every state an ingestion surface can name: the seven surface states, and the two only an upload has. */
export type IngestionMark = SurfaceState | 'queued' | 'canceled'

export const INGESTION_GLYPH: Record<IngestionMark, LucideIcon> = {
  // Waiting its turn: for an upload slot, or in the office's ingest queue.
  queued: Clock,
  uploading: ArrowUp,
  // Piloti is reading it. A page with lines, not a spinner: see above.
  reading: ScanText,
  citable: Check,
  // The content check's shield (ADR-0086), the same one the Quarantäne uses.
  held: ShieldAlert,
  unreadable: CircleAlert,
  // At rest and not read: an open ring, quieter than a decision.
  stored: CircleDashed,
  unknown: CircleHelp,
  // The reader stopped it: a decision, never a failure.
  canceled: Ban,
}

/** The mark of an upload phase. Reading and the read are the surface states; waiting and cancelling are the tray's own. */
export function ingestionMarkOfPhase(phase: UploadPhase): IngestionMark {
  switch (phase) {
    case 'queued':
      return 'queued'
    case 'uploading':
      return 'uploading'
    case 'processing':
      return 'reading'
    case 'ready':
      return 'citable'
    case 'held':
      return 'held'
    case 'stored':
      return 'stored'
    case 'failed':
      return 'unreadable'
    case 'canceled':
      return 'canceled'
  }
}

/**
 * The ink of a state written as a word on a plain surface (the tray row).
 * Colour only where the state asks something of the reader or answers the
 * question they came with: green „citable", amber „a person decides", red „it
 * broke". Everything in motion or at rest is muted ink, and the glyph tells
 * those apart.
 */
const WORD_TONE: Record<IngestionMark, string> = {
  queued: 'text-muted-foreground',
  uploading: 'text-muted-foreground',
  reading: 'text-muted-foreground',
  citable: 'text-success',
  held: 'text-warning',
  unreadable: 'text-error',
  stored: 'text-muted-foreground',
  unknown: 'text-muted-foreground',
  canceled: 'text-muted-foreground',
}

/** A state's glyph, at the size the badges and chips own (`size-3.5`). */
export function IngestionGlyph({ mark, className }: { mark: IngestionMark; className?: string }): JSX.Element {
  const Glyph = INGESTION_GLYPH[mark]
  return <Glyph data-mark={mark} className={cn('size-3.5 shrink-0', className)} aria-hidden />
}

/**
 * A state as glyph + word in the state's ink, for a surface that has no room
 * or no reason for a pill: the tray row's status column.
 *
 * `quiet` keeps the glyph and drops the colour, for a sentence that is not the
 * state's own word (the server's „unchanged – already here").
 */
export function IngestionStatusWord({
  mark,
  quiet = false,
  className,
  children,
}: {
  mark: IngestionMark
  quiet?: boolean
  className?: string
  children: ReactNode
}): JSX.Element {
  return (
    <span
      data-mark={mark}
      className={cn(
        'inline-flex min-w-0 items-center gap-1 whitespace-nowrap',
        quiet ? 'text-muted-foreground' : WORD_TONE[mark],
        className
      )}
    >
      <IngestionGlyph mark={mark} />
      {children}
    </span>
  )
}
