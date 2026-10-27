'use client'

/**
 * The viewer Piloti's viewer actions move (ADR-0144), mounted once with the chat.
 *
 * It registers the runner (`lib/viewer-action-runner.ts`) with the chat's
 * viewer actions and holds the Fassung comparison a `compare_revisions` opens.
 * Nothing renders while no comparison is open. The room check is the peek's own
 * (`peekHasRoom`), and the host tells the chat whenever it changes, so a
 * citation's „Neben dem Chat öffnen“ and the page's declared client tools follow
 * a rotated phone or a route change at once.
 */

import { useEffect, useRef, type JSX } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import { noteViewerRoom, registerViewerActionRunner } from '@/features/chat/lib/viewer-actions'
import { useIsMobile } from '@/hooks/use-is-mobile'
import { createViewerActionRunner } from '../lib/viewer-action-runner'
import { peekHasRoom } from '../lib/peek-room'
import { useRevisionCompare } from './revision-compare'

export function ViewerActionHost(): JSX.Element | null {
  const router = useRouter()
  const pathname = usePathname()
  const isMobile = useIsMobile()
  const { openRevisionCompare, closeRevisionCompare, compareElement } = useRevisionCompare()
  const room = useRef(false)
  room.current = peekHasRoom(pathname, isMobile)

  useEffect(
    () =>
      registerViewerActionRunner(
        createViewerActionRunner({
          hasRoom: () => room.current,
          openCompare: openRevisionCompare,
          closeCompare: closeRevisionCompare,
          navigate: (href) => router.push(href),
          currentHref: () => `${window.location.pathname}${window.location.search}`,
        })
      ),
    [openRevisionCompare, closeRevisionCompare, router]
  )

  const hasRoom = room.current
  useEffect(() => noteViewerRoom(hasRoom), [hasRoom])

  return compareElement
}
