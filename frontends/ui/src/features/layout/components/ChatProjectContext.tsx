'use client'

import type { FC } from 'react'

import { ConnectionBand } from '@/components/shell/connection-band'
import { ProjectPill } from '@/components/shell/project-pill'
import { ShellSearchButton } from '@/components/shell/shell-search-button'
import { useShellOverlays } from '@/components/shell/shell-overlays'
import { useIsMobile } from '@/hooks/use-is-mobile'
import { useTranslations } from '@/i18n'
import { cn } from '@/lib/utils'

interface ChatProjectContextProps {
  /** The active project's name; absent while the project list has not loaded. */
  projectName?: string | null
  className?: string
}

/**
 * Where the reader is, and the two ways out, on the chat route of the phone
 * shell.
 *
 * Every other route has a phone header with the project pill, the search and
 * the connection line. Chat hides it because its toolbar is its own top band,
 * which left the one route a person is on most with no way to another project,
 * no search and no word that the link is gone. This is the same three atoms
 * the header uses (`ProjectPill`, `ShellSearchButton`, `ConnectionBand`),
 * above the toolbar's own pills: orientation first, the thread under it.
 *
 * Phone shell only (`md:hidden`, which is `useIsMobile`'s complement). The
 * connection line mounts only there, because its presence check pings on an
 * interval and the rail's indicator already runs one on a desktop.
 */
export const ChatProjectContext: FC<ChatProjectContextProps> = ({ projectName, className }) => {
  const t = useTranslations('nav')
  const isMobile = useIsMobile()
  const sheetOpen = useShellOverlays((s) => s.projectSheetOpen)
  const setSheetOpen = useShellOverlays((s) => s.setProjectSheetOpen)
  const label = projectName
    ? t('projectSwitcher.switchCurrent', { name: projectName })
    : t('projectSwitcher.select')
  return (
    <div
      data-testid="chat-project-context"
      className={cn('pointer-events-none flex flex-col md:hidden', className)}
    >
      <div className="flex items-center justify-between gap-2">
        <ProjectPill
          name={projectName ?? t('projectSwitcher.select')}
          label={label}
          expanded={sheetOpen}
          onOpen={() => setSheetOpen(true)}
          // The pill takes the row, the search keeps its 44px: the project is the
          // one thing this row says, so it reads whole.
          className="pointer-events-auto max-w-none flex-1 sm:max-w-80 sm:flex-none"
        />
        <ShellSearchButton className="pointer-events-auto" />
      </div>
      {isMobile && <ConnectionBand appearance="line" />}
    </div>
  )
}
