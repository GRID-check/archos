/**
 * The review's own pieces, for a Skizze's marks drawn over its live canvas
 * (`features/diagrams/sketch/sketch-pins.tsx`). A top-level module rather than
 * the index: the sketch canvas sits below every rendered Markdown fence, and
 * the index's upload hooks put the folder rules and upload screening below it
 * too (`task workspace:blast-radius`).
 */
export type { DocumentReview, ReviewDraft } from './hooks/use-document-review'
export { ReviewPageLayer } from './components/review/review-page-layer'
export { DraftCard, ThreadCard } from './components/review/thread-card'
