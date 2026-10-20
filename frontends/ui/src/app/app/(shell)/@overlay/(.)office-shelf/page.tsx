/**
 * The Archiv, intercepted: a soft navigation to `/app/office-shelf` renders the
 * sheet here, above whatever page the reader was on, while the URL is the
 * Archiv's own. A hard load takes the real page instead (`../../office-shelf`),
 * which renders the same sheet standing alone.
 */
import type { JSX } from 'react'
import { OfficeShelfSheet } from '../../office-shelf/office-shelf-sheet'

export default function OfficeShelfOverlayPage(): JSX.Element {
  return <OfficeShelfSheet standalone={false} />
}
