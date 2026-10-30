/**
 * Where a Skizze's link leads: a document's page, its model's element, an
 * Anmerkung (`features/diagrams/sketch/sketch-links.tsx`). Its own top-level
 * module, apart from the index and from `sketch-review.ts`: the links are drawn
 * on every sketch canvas, and either of those would put the review's whole
 * subtree below it (`task workspace:blast-radius`).
 */
export { sketchLinkHref, type AvailableSketchLink } from './lib/sketch-link-href'
