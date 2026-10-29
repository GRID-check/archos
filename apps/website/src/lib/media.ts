/**
 * The product screenshots, and how wide the page shows each kind of image, so that Astro's
 * `<Image>` writes a `srcset` and a phone loads a variant near its own width instead of the
 * 2560 px master. The masters live in `src/assets/media/` (Astro hashes the built files, so a
 * replaced screenshot gets a new URL and no cache serves the old one).
 */
import planRevisionChanges from '../assets/media/product-plan-revision-changes.webp';
import searchDerivation from '../assets/media/product-search-derivation.webp';
import compareClearance from '../assets/media/product-compare-clearance.webp';
import modelCheck from '../assets/media/product-model-check.webp';
import floorPlanQuery from '../assets/media/product-floor-plan-query.webp';

export const productImages = {
  planRevisionChanges,
  searchDerivation,
  compareClearance,
  modelCheck,
  floorPlanQuery,
};

/** Widths built from each 2560 px master. */
export const SCREENSHOT_WIDTHS = [640, 960, 1280, 1920, 2560];

/** Screenshots are text-heavy: keep them sharp. */
export const SCREENSHOT_QUALITY = 85;

/**
 * Rendered widths, from the design system's layout (`components.css`): the hero image spans the
 * window less `gutter-wide` (64 px) a side, `gutter-mobile` (16 px) on a phone; a content image
 * spans the container (1280 px less 32 px a side); a gallery card is the container's content
 * width, or the window less 96 px, and below 1024 px its image is 500 px high at 5:2, so 1250 px wide.
 */
export const SIZES = {
  hero: '(max-width: 767px) calc(100vw - 32px), calc(100vw - 128px)',
  container: '(max-width: 767px) calc(100vw - 32px), (max-width: 1280px) calc(100vw - 64px), 1216px',
  gallery: '(max-width: 1023px) 1250px, min(1216px, calc(100vw - 96px))',
};
