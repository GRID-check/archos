'use client'

/**
 * A document tile's two triggers: the ⋯ and the right-click.
 *
 * Wraps the tile in a context menu and exposes the overflow button through
 * {@link DocumentActionsTrigger}, so FileCard/FileListView keep their `actions`
 * slot and do not need to know which primitive opened. Dialogs live here once
 * so closing the menu does not unmount a rename already in flight.
 *
 * ## Built on the first ask, not on mount
 *
 * A listing mounts one of these per row, and a row's menu used to cost a
 * dropdown root, three closed dialogs and the whole entry list (with every
 * folder of the shelf labelled and sorted for „Verschieben") whether or not
 * anybody ever opened it. Now a row starts as its tile, the context-menu host
 * and a plain ⋯ button. The first right-click, long-press, press or key on the
 * ⋯ makes the row live: the entries are built, the dialogs mount, the ⋯
 * becomes the real dropdown (opened by the same press), and the row stays live.
 *
 * The context-menu host is there from the start on purpose. Wrapping the tile
 * in it only once the menu is wanted would remount the card under the pointer,
 * and the browser delivers the first right-click to the host that is there
 * when it happens.
 */

import { createContext, useCallback, useContext, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react'
import { ActionMenu } from '@/components/ui/action-menu'
import { useTranslations } from '@/i18n'
import { DOCUMENT_SCOPE_COPY } from './document-scope'
import {
  DEFAULT_DOCUMENT_ACTIONS,
  type DocumentActionKind,
} from './action-entries'
import {
  useDocumentActionMenu,
  type DocumentActionsMenuProps,
} from './document-actions-menu'
import { MoreHorizontal } from 'lucide-react'
import { Button } from '@/components/ui/button'

const TriggerContext = createContext<ReactNode>(null)

export function DocumentActionsTrigger(): ReactNode {
  return useContext(TriggerContext)
}

export interface DocumentObjectMenuProps extends Omit<
  DocumentActionsMenuProps,
  'trigger' | 'align' | 'side' | 'actions'
> {
  actions?: readonly DocumentActionKind[]
  children: ReactNode
  asChild?: boolean
}

/** The keys a menu button opens on (WAI-ARIA menu button; what Radix's trigger answers). */
const OPENING_KEYS = new Set(['Enter', ' ', 'ArrowDown'])

export function DocumentObjectMenu({
  children,
  actions = DEFAULT_DOCUMENT_ACTIONS,
  asChild = false,
  ...props
}: DocumentObjectMenuProps): ReactNode {
  const t = useTranslations(DOCUMENT_SCOPE_COPY[props.scope])
  /** Whether anybody has asked for this row's menu yet. Once true, it stays. */
  const [live, setLive] = useState(false)
  const [dropdownOpen, setDropdownOpen] = useState(false)
  const { entries, dialogs, name } = useDocumentActionMenu({ ...props, actions, live })

  const openDropdown = useCallback(() => {
    setLive(true)
    setDropdownOpen(true)
  }, [])
  const onContextOpenChange = useCallback((open: boolean) => {
    if (open) setLive(true)
  }, [])

  const buttonProps = {
    type: 'button' as const,
    variant: 'ghost' as const,
    size: 'icon' as const,
    className: 'size-8 shrink-0 bg-background/80 shadow-2xs backdrop-blur-sm',
    'aria-label': t('actions.label', { name }),
    'aria-haspopup': 'menu' as const,
    title: t('actions.menuLabel'),
  }
  const icon = <MoreHorizontal className="size-4" aria-hidden />

  const trigger = live ? (
    <ActionMenu
      mode="dropdown"
      entries={entries}
      open={dropdownOpen}
      onOpenChange={setDropdownOpen}
      trigger={
        <Button {...buttonProps} data-testid="document-actions-trigger">
          {icon}
        </Button>
      }
    />
  ) : (
    // Opens on the same events the dropdown's own trigger does: a primary
    // press (not a ctrl-click, which is a right-click on a Mac), or Enter,
    // Space and ArrowDown. The press is the one that opens it; nothing waits
    // for a second.
    <Button
      {...buttonProps}
      data-testid="document-actions-trigger"
      aria-expanded={false}
      onPointerDown={(event: PointerEvent<HTMLButtonElement>) => {
        if (event.button !== 0 || event.ctrlKey) return
        event.preventDefault()
        openDropdown()
      }}
      onKeyDown={(event: KeyboardEvent<HTMLButtonElement>) => {
        if (!OPENING_KEYS.has(event.key)) return
        event.preventDefault()
        openDropdown()
      }}
    >
      {icon}
    </Button>
  )

  return (
    <TriggerContext.Provider value={trigger}>
      <ActionMenu mode="context" entries={entries} asChild={asChild} keepHost onOpenChange={onContextOpenChange}>
        {children}
      </ActionMenu>
      {dialogs}
    </TriggerContext.Provider>
  )
}
