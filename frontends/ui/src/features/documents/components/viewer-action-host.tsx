'use client'

/**
 * The viewer Piloti's viewer actions move (ADR-0141), mounted once with the chat.
 *
 * It registers the runner (`lib/viewer-action-runner.ts`) with the chat's
 * viewer actions and holds the Fassung comparison a `compare_revisions` opens.
 * Nothing renders while no comparison is open. The room check is the peek's own
 * (`useFilePeekPlacement`): beside a chat on a screen wide enough for two panes.
 */

import { useEffect, useRef, type JSX } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import { registerViewerActionRunner } from '@/features/chat/lib/viewer-actions'
import { useIsMobile } from '@/hooks/use-is-mobile'
import { createViewerActionRunner } from '../lib/viewer-action-runner'
import { useRevisionCompare } from './revision-compare'

export function ViewerActionHost(): JSX.Element | null {
  const router = useRouter()
  const pathname = usePathname()
  const isMobile = useIsMobile()
  const { openRevisionCompare, closeRevisionCompare, compareElement } = useRevisionCompare()
  const room = useRef(false)
  room.current = !isMobile && Boolean(pathname?.includes('/chat'))

  useEffect(
    () =>
      registerViewerActionRunner(
        createViewerActionRunner({
          hasRoom: () => room.current,
          openCompare: (older, newer) => openRevisionCompare(older, newer),
          closeCompare: closeRevisionCompare,
          navigate: (href) => router.push(href),
          back: () => router.back(),
        })
      ),
    [openRevisionCompare, closeRevisionCompare, router]
  )

  return compareElement
}
