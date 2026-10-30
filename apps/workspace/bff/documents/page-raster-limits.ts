/**
 * The bounds of a page raster (S6, `page-raster.ts`): pure, so the editor, the
 * scene check and the filing read the same numbers the route enforces.
 */

/** The resolutions a page is drawn at; a Skizze's underlay names one of them. */
export const PAGE_RASTER_DPIS = [100, 150, 200] as const
export type PageRasterDpi = (typeof PAGE_RASTER_DPIS)[number]
export const DEFAULT_PAGE_RASTER_DPI: PageRasterDpi = 150
/** The long side, in pixels: an A0 sheet at 150 dpi would be 7016 and is drawn smaller. */
export const MAX_PAGE_RASTER_LONG_SIDE = 4096
/** A page raster's PNG at most. An A3 sheet at 150 dpi is 328 KB; a dense CAD sheet about twice that. */
export const MAX_PAGE_RASTER_BYTES = 4 * 1024 * 1024
