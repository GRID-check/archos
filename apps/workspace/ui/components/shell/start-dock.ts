/**
 * The panel docked at the start edge of the page, beside `<main>`: which one
 * is open, and how wide the reader made it.
 *
 * The shell owns the place (`AppShellChrome` wraps the page in a
 * `DockedSplit`), the app layout hands it what may go there (`startDock`, the
 * Postfach), and any door to a panel writes here: the rail's Postfach entry,
 * the org header's bell. A panel is a list worked BESIDE the real page, so
 * opening one never moves the reader; an entry in it navigates the page.
 *
 * A preference, not an overlay: it stays open across pages, and across a
 * reload in the same tab (sessionStorage), the way the rail's own state does.
 * The width is the reader's on this device (localStorage), as the file peek's
 * is. Both are read after mount (`restore`), so the server and the first
 * client render agree.
 */

import { create } from 'zustand'

import { DOCK_LAYOUT_QUERY } from '@/hooks/use-is-mobile'
import { useMediaQuery } from '@/hooks/use-media-query'

/** The panels that dock at the start edge. One at a time. */
export type StartDockPanel = 'inbox'

export const START_DOCK_WIDTH_MIN = 280
export const START_DOCK_WIDTH_MAX = 520
export const START_DOCK_WIDTH_DEFAULT = 360

const OPEN_KEY = 'startDock.panel'
const WIDTH_KEY = 'startDock.width'

const clampWidth = (width: number): number => Math.min(START_DOCK_WIDTH_MAX, Math.max(START_DOCK_WIDTH_MIN, Math.round(width)))

/** Storage can be absent or refuse (a private window, blocked site data): the dock then just forgets. */
function read(storage: () => Storage, key: string): string | null {
  try {
    return storage().getItem(key)
  } catch {
    return null
  }
}

function write(storage: () => Storage, key: string, value: string | null): void {
  try {
    if (value === null) storage().removeItem(key)
    else storage().setItem(key, value)
  } catch {
    // Not remembered; nothing else changes.
  }
}

const session = (): Storage => window.sessionStorage
const local = (): Storage => window.localStorage

interface StartDockState {
  panel: StartDockPanel | null
  width: number
  open: (panel: StartDockPanel) => void
  close: () => void
  toggle: (panel: StartDockPanel) => void
  setWidth: (width: number) => void
  /** The stored width, or null; adopted by the split before it first sizes the panel. */
  restoreWidth: () => number | null
  /** The panel this tab had open before a reload. Called once the client has mounted. */
  restore: () => void
}

export const useStartDock = create<StartDockState>()((set, get) => ({
  panel: null,
  width: START_DOCK_WIDTH_DEFAULT,
  open: (panel) => {
    set({ panel })
    write(session, OPEN_KEY, panel)
  },
  close: () => {
    set({ panel: null })
    write(session, OPEN_KEY, null)
  },
  toggle: (panel) => (get().panel === panel ? get().close() : get().open(panel)),
  setWidth: (width) => {
    const next = clampWidth(width)
    set({ width: next })
    write(local, WIDTH_KEY, String(next))
  },
  restoreWidth: () => {
    const stored = Number(read(local, WIDTH_KEY))
    if (!Number.isFinite(stored) || stored <= 0) return null
    const width = clampWidth(stored)
    set({ width })
    return width
  },
  restore: () => {
    const stored = read(session, OPEN_KEY)
    if (stored === 'inbox') set({ panel: stored })
  },
}))

export const defaultStartDockWidth = (): number => START_DOCK_WIDTH_DEFAULT

/**
 * A door's state and its click, for the link that is the door. `open` is said
 * as expanded (`aria-expanded`), never as active: active is the page the
 * reader is on.
 */
export interface StartDockDoor {
  open: boolean
  onClick: (event: { defaultPrevented: boolean; button: number; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; preventDefault: () => void }) => void
}

/**
 * A door to a docked panel, for a link that also has a page of its own (the
 * Postfach's `/app/inbox`): where the panel fits, a plain click opens or
 * closes it beside the page; anything else (a phone, a new tab, a middle
 * click) follows the link as it always did. `open` says the panel is out, so
 * the door can be drawn as the place the reader is.
 */
export function useStartDockDoor(panel: StartDockPanel): StartDockDoor {
  const fits = useMediaQuery(DOCK_LAYOUT_QUERY)
  const open = useStartDock((state) => state.panel === panel) && fits
  const toggle = useStartDock((state) => state.toggle)
  return {
    open,
    onClick: (event) => {
      const plain = event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey
      if (!fits || !plain || event.defaultPrevented) return
      event.preventDefault()
      toggle(panel)
    },
  }
}
