'use client'

/**
 * The connection state on a phone, in the top band where it is seen.
 *
 * On a desktop the presence dot sits in the rail's footer, always in view. On
 * a phone that footer is inside a closed drawer, so the one reader most likely
 * to lose the network (on site, in a basement, between cells) learned it only
 * after a send failed. This is a thin line under the mobile header that says
 * so while it is true and takes no space while all is well.
 *
 * Mounted only below `md` (the caller checks), because the presence hook pings
 * on an interval and the rail's own indicator already runs one on a desktop.
 * The status region stays in the tree while connected, visually hidden, so the
 * change to offline is announced rather than inserted silently.
 */

import type { JSX } from 'react'

import { useConnectionPresence } from '@/shared/hooks/use-connection-presence'
import { cn } from '@/lib/utils'
import { ConnectionPresenceIndicator } from './connection-presence-indicator'

export function ConnectionBand({ className }: { className?: string }): JSX.Element {
  const presence = useConnectionPresence()
  const quiet = presence === 'connected'
  return (
    <div
      data-slot="connection-band"
      data-presence={presence}
      className={cn(
        quiet
          ? 'sr-only'
          : 'border-border animate-in fade-in-0 duration-quick flex h-7 w-full items-center justify-center border-t px-4 motion-reduce:animate-none',
        className
      )}
    >
      <ConnectionPresenceIndicator presence={presence} />
    </div>
  )
}
