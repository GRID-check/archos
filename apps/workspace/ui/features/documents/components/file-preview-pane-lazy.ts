import dynamic from 'next/dynamic'

/**
 * The building itself, in the well where a PDF shows its pages.
 *
 * `ssr: false` because the viewport underneath reaches for `navigator.gpu`, and
 * `dynamic` because it pulls the BIM hooks and (behind one more boundary) a
 * multi-megabyte WASM kernel — none of which belongs in the bundle of a pane
 * that is usually opened on a PDF.
 */
export const IfcFilePreview = dynamic(
  () =>
    import('@/features/bim/components/ifc-file-preview').then((module) => module.IfcFilePreview),
  { ssr: false }
)

/**
 * The model's own facts in the metadata rail — storeys, elements, rooms, area.
 *
 * The rail's job is "what did Grid make of this file", and for a model the
 * indexed panel below can only answer with the digest's passage count, which
 * describes the prose written about the building rather than the building.
 * Same boundary as the viewport: one import, and nothing here knows what a
 * storey is.
 */
export const IfcFileFacts = dynamic(
  () => import('@/features/bim/components/ifc-file-facts').then((module) => module.IfcFileFacts),
  { ssr: false }
)
