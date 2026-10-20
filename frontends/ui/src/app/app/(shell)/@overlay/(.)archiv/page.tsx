/**
 * The Archiv, intercepted: a soft navigation to `/app/archiv` renders the
 * sheet here, above whatever page the reader was on, while the URL is the
 * Archiv's own. A hard load takes the real page instead (`../../archiv`),
 * which renders the same sheet standing alone.
 */
import type { JSX } from 'react'
import { OfficeShelfSheet } from '../../archiv/office-shelf-sheet'

export default function OfficeShelfOverlayPage(): JSX.Element {
  return <OfficeShelfSheet standalone={false} />
}
