'use client'

/**
 * Who an inbox item is from, drawn the same wherever an item is listed: its
 * row in the Postfach and its line in the queue's news.
 */

import type { JSX } from 'react'
import {
  AlertTriangle,
  AtSign,
  CheckCircle2,
  Clock,
  HardDrive,
  Layers,
  Megaphone,
  MessageSquare,
  ShieldAlert,
  UserPlus,
  type LucideIcon,
} from 'lucide-react'

import { INBOX_TYPE_PRESENTATION, UNKNOWN_TYPE_PRESENTATION, type InboxItemView, type InboxTypePresentation } from '@/lib/inbox/types'
import { AgentGlyph } from '@/components/ui/agent-glyph'
import { PersonAvatar } from '@/components/ui/avatar-stack'
import { cn } from '@/lib/utils'

/**
 * The ONE place the registry's icon names become components. Keeping the map here
 * (rather than storing components in `lib/inbox/types.ts`) keeps the registry a
 * plain data module that the server half can import without pulling in React.
 * `piloti` is not a Lucide icon but the agent's own glyph, drawn below.
 */
const ICONS: Record<Exclude<InboxTypePresentation['icon'], 'piloti'>, LucideIcon> =
  {
    'at-sign': AtSign,
    'message-square': MessageSquare,
    'user-plus': UserPlus,
    'check-circle': CheckCircle2,
    'hard-drive': HardDrive,
    'alert-triangle': AlertTriangle,
    clock: Clock,
    layers: Layers,
    megaphone: Megaphone,
    'shield-alert': ShieldAlert,
  }

/**
 * Who an inbox item is from, in one material wherever an item is listed (its
 * row, the queue's news): a person's face, the agent's glyph, or the type's glyph
 * for a system notice, all on the same neutral ground. The registry's icon
 * decides; a row whose type this build does not know reads as a system notice.
 */
export function InboxItemFace({ item, size = 'md' }: { item: InboxItemView; size?: 'sm' | 'md' }): JSX.Element {
  const presentation = INBOX_TYPE_PRESENTATION[item.type] ?? UNKNOWN_TYPE_PRESENTATION
  if (presentation.icon === 'piloti') return <AgentGlyph size={size === 'md' ? 'lg' : 'md'} tone="outline" />
  if (item.actorUserId && item.actorName) {
    return <PersonAvatar person={{ userId: item.actorUserId, name: item.actorName }} size={size} />
  }
  const Icon = ICONS[presentation.icon]
  return (
    <span className={cn('flex items-center justify-center rounded-full bg-muted text-muted-foreground', size === 'md' ? 'size-8' : 'size-7')}>
      <Icon className={size === 'md' ? 'size-4' : 'size-3.5'} />
    </span>
  )
}
