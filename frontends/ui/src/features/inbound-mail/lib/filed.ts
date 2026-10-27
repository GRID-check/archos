/**
 * What a filing became, in the words the detail and its toast say it
 * („S-101_C.pdf → Tragwerk · Fassung 3“, „Text → „Stellplatznachweis“ ·
 * Fassung 7“), read off the parts' `filedAs`: the server's, filled only for a
 * document the viewer may read. A part without it is counted as filed and
 * never placed.
 *
 * Pure.
 */

import type { InboundMailPartView } from '@/lib/inbound-mail/inbound-mail-wire'

/** Where one filed part went. */
export interface FiledPlace {
  /** The document's name now (the E-Mail-Verlauf's, for the text). */
  name: string
  /** The folder, or the root's label. */
  folder: string
  version: number | null
}

/** Where this part went, or null when it is not filed or the viewer may not see where. */
export function filedPlace(part: Pick<InboundMailPartView, 'filedAs'>, rootLabel: string): FiledPlace | null {
  if (!part.filedAs) return null
  const { name, folderPath, version } = part.filedAs
  return { name, folder: folderPath && folderPath !== '' ? folderPath : rootLabel, version }
}

/** One line of a filing's confirmation. */
export type FiledLine = { kind: 'attachment' | 'message'; place: FiledPlace }

/** The lines for these filed parts, the text first, in the parts' order; parts the viewer may not place are left out. */
export function filedLines(parts: readonly InboundMailPartView[], partIds: readonly string[], rootLabel: string): FiledLine[] {
  const wanted = new Set(partIds)
  return parts
    .filter((part) => wanted.has(part.id) && part.state === 'filed')
    .sort((a, b) => (a.kind === b.kind ? a.position - b.position : a.kind === 'message' ? -1 : 1))
    .flatMap((part) => {
      const place = filedPlace(part, rootLabel)
      return place ? [{ kind: part.kind, place }] : []
    })
}
