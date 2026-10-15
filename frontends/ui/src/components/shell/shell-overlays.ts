/**
 * Which of the shell's own overlays is open: the command palette and, on a
 * phone, the project switcher sheet.
 *
 * Lifted out of the components that render them because each has more than one
 * door. The palette used to keep its open state inside `KeyboardShortcuts`, so
 * ⌘K was the only way in and a phone, which has no ⌘K, had none at all. The
 * search button in the mobile header and in the org header now writes the same
 * flag the chord does. The switcher sheet opens from the project pill in the
 * mobile header and from the switcher row in the drawer.
 *
 * Not persisted, and kept out of the layout store for that reason: that store is
 * `persist`ed, and an overlay that reopens itself after a reload is a bug, not a
 * preference.
 */

import { create } from 'zustand'

interface ShellOverlaysState {
  paletteOpen: boolean
  projectSheetOpen: boolean
  moreSheetOpen: boolean
  setPaletteOpen: (open: boolean) => void
  togglePalette: () => void
  setProjectSheetOpen: (open: boolean) => void
  setMoreSheetOpen: (open: boolean) => void
}

export const useShellOverlays = create<ShellOverlaysState>()((set) => ({
  paletteOpen: false,
  projectSheetOpen: false,
  moreSheetOpen: false,
  setPaletteOpen: (open) => set({ paletteOpen: open }),
  togglePalette: () => set((state) => ({ paletteOpen: !state.paletteOpen })),
  setProjectSheetOpen: (open) => set({ projectSheetOpen: open }),
  setMoreSheetOpen: (open) => set({ moreSheetOpen: open }),
}))
