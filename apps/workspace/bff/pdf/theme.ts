/**
 * The printed product's palette, type scale and page geometry.
 *
 * ## Why the tokens are copied rather than read
 *
 * The brand neutrals (ink, surfaces, line) are CSS custom properties (`shared/brand/tokens.vars.css`,
 * the synced copy of packages/brand), and the app maps its own names onto them in
 * `ui/styles/tokens.css` with `oklch()` and `color-mix()`. react-pdf has
 * neither: `StyleSheet.create` resolves no variables and pdfkit understands no
 * colour space but sRGB. So the handful of tokens a document actually needs are
 * transcribed here as the hex values the token file itself already carries in
 * its comments — one named place, next to the renderer that consumes it, rather
 * than a literal sprinkled through four components.
 *
 * Every entry below names the token it came from. When a token moves, this file
 * is the only thing that has to move with it.
 *
 * ## Why light-mode values only
 *
 * A PDF is printed, forwarded and filed. It has no viewer preference to react
 * to and no dark surface to sit on, so the dark ramp is deliberately absent:
 * the document is always the light, warm-paper treatment the app shows by
 * default, which is also the only one that survives a laser printer.
 */

/** Colours, each transcribed from the token named in its comment. */
export const PDF_THEME = {
  /** `--ds-ink` — the strongest ink; headings, and the cover band's ground. */
  ink: '#0f0e0d',
  /** `--ds-ink-hover` — body copy, one step off ink so long prose stays soft. */
  body: '#2e2c29',
  /** `--ds-ink-muted` — meta lines, labels, the footer. */
  subtle: '#5e5b57',
  /** `--ds-on-ink` — type on the ink band. */
  inverse: '#fafaf9',
  /**
   * The page ground: pure white, DOCUMENTED EXCEPTION to the brand's "never
   * #ffffff". A document is printed, scanned and mailed on, and a warm
   * #fafaf9 ground costs toner and prints as a grey wash on an office laser;
   * white paper is what the sheet is made of. Every other colour here is a
   * brand token.
   */
  paper: '#ffffff',
  /** `--ds-surface` — the warm paper the app sits on; used for inset panels. */
  panel: '#fafaf9',
  /** `--ds-surface-sunken` — table header band, code ground. */
  surface: '#f2f1f0',
  /** `--ds-surface` — the zebra step; one shade off `surface` so rows separate quietly. */
  surfaceAlt: '#fafaf9',
  /** `--ds-line` — the hairline. */
  hairline: '#e7e5e3',
  /** `--ds-line` stepped 6% toward ink; the heavier rule under a section head. */
  rule: '#dad8d6',
  /** `--source-law` — the Baurecht signal blue. The document's one accent. */
  accent: '#2359d3',
  /** `--source-law-text` — the readable-on-paper version of the accent. */
  accentInk: '#1c47ab',
  /** `--source-law-tint` — the accent's surface, for citation markers. */
  accentTint: '#e6edfb',
} as const

/**
 * Type scale.
 *
 * Sized for A4 rather than for a screen: 10pt body is the smallest size that
 * still reads after a document has been printed, scanned and mailed on, which
 * is the last hop of most of these files.
 */
export const PDF_TYPE = {
  /** The document's own name on the cover; scaled down for long titles. */
  coverTitle: 30,
  coverTitleLong: 23,
  /** Above this many characters the cover title takes the smaller size. */
  coverTitleBreak: 46,
  h1: 19,
  h2: 13.5,
  h3: 10.5,
  body: 10,
  meta: 8.5,
  table: 9,
  chrome: 8,
  mono: 8.5,
  /** Generous rather than tight — the document is read, not skimmed. */
  lineHeight: 1.55,
  lineHeightTight: 1.25,
} as const

/**
 * Page geometry, in PostScript points.
 *
 * The horizontal margin is the 2 cm an Austrian office expects to be able to
 * punch and file; the vertical ones are larger because the running header and
 * the page footer live inside them, and type that touches its own chrome reads
 * as a layout accident.
 */
export const PDF_PAGE = {
  /** 2 cm. */
  margin: 56.69,
  /** Room for the running header plus its hairline. */
  marginTop: 78,
  /** Room for the page footer plus its hairline. */
  marginBottom: 62,
  /** Where the fixed header and footer sit, measured from the page edge. */
  headerTop: 34,
  footerBottom: 30,
} as const
