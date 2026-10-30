/**
 * What another feature takes from the document review without reaching into
 * its components (the `feature-deep-import` seam): the link that opens a mark
 * and returns where it came from, and the shape of an answer its composer
 * sends. The inbox opens marks and answers them from its rows.
 */

export { withReviewBack } from './lib/open-review'
export type { ComposerSend } from './components/review/composer'
