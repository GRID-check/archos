'use client'

import { PHONE_QUERY } from '@/hooks/use-is-mobile'
import { useMediaQuery } from '@/hooks/use-media-query'

/**
 * Whether the Dateien page is drawn for a phone: a phone-sized screen, below
 * `sm` or a phone on its side, where the section header stacks (or has no
 * height to spare) and a row of controls no longer has the room for them.
 *
 * The shell's own `phone` question (`PHONE_QUERY`, which the `phone:` variant
 * in `globals.css` repeats and `breakpoints.spec.ts` holds equal), and not
 * `useIsMobile`: that one is the shell's `md`, and what the preview uses to go
 * full screen. Whether a search field, a filter and a view toggle fit one row
 * is a question about the row. The classes in this feature (`phone:`) ask the
 * same, so a folder that becomes a row and a header that becomes one line
 * change at the same width.
 *
 * The server renders `false`, and the controls it governs are mounted on the
 * client only (they portal into the section header from a layout effect), so
 * nothing flashes.
 */
export function usePhoneLayout(): boolean {
  return useMediaQuery(PHONE_QUERY)
}
