/**
 * The categorical chart palette's slot count. The colours themselves are typed
 * once, in `ui/styles/data-palette.css`, with the validator notes: a chart
 * styles its marks with `var(--chart-series-N)` / `--chart-series-other` inside
 * an element carrying the `usage-viz` class, and the dark steps switch under
 * `.dark` on their own. Slot ORDER is the colour-blind-safety mechanism: never
 * reorder or cycle, and entities beyond the last slot fold into "other".
 */
export const SERIES_SLOT_COUNT = 8
