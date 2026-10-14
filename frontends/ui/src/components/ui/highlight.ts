/**
 * Highlight — the mark on the things a pending decision would touch: the cards
 * and rows a filing suggestion would move, while the person looks at the
 * control that would move them.
 *
 * An outline in the strongest hairline (`outline-strong`, the 32% ink border)
 * and nothing else: no fill, no shadow, no size change, so a lit tile is
 * exactly as tall as an unlit one and the grid never moves. Two recipes, the
 * same split as `focus-ring.ts`.
 */

/** A tile on an open ground: the outline held 2px off its edge. */
export const HIGHLIGHT_OUTLINE = 'outline-2 outline-offset-2 outline-strong'

/**
 * A row inside a clipping container (a table's scroll box, the upload tray's
 * list): the same outline drawn inside the row, where the container cannot
 * slice off its sides.
 */
export const HIGHLIGHT_OUTLINE_INSET = 'outline-2 -outline-offset-2 outline-strong'
