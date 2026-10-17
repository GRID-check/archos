/**
 * What a file is, for the purpose of drawing it.
 *
 * Decided from the file name alone, because that is all a Fassung reference
 * carries (`FassungRef` has an id and a name). The preview pane decides from the
 * stored content type as well; here a wrong guess costs a load error that the
 * comparison already handles, so the name is enough.
 */

import { isOfficeRenditionSource } from '@/lib/documents/preview-types'

export type CompareKind = 'pdf' | 'office' | 'image' | 'unsupported'

/**
 * Raster and vector formats a browser draws on a canvas. TIFF is absent on
 * purpose: the preview route serves it, but no browser decodes it.
 */
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg'])

export function compareKindOf(filename: string): CompareKind {
  const name = filename.trim().toLowerCase()
  const dot = name.lastIndexOf('.')
  const extension = dot >= 0 ? name.slice(dot) : ''
  if (extension === '.pdf') return 'pdf'
  if (IMAGE_EXTENSIONS.has(extension)) return 'image'
  if (isOfficeRenditionSource({ filename })) return 'office'
  return 'unsupported'
}
