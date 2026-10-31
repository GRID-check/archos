/**
 * What carrying a mark on a model to a newer Fassung makes of its viewpoint
 * (migration 0194), as pure functions of the stored row and the GlobalIds the
 * new Fassung has. No `server-only`, no database: the service asks the model
 * which ids are there (`./viewpoint-carry.ts`), this decides what follows.
 *
 * A viewpoint is never changed (BCF: "should never be changed once created").
 * The carry writes a new one: the same camera and section planes, and of the
 * elements only those the new Fassung still has, matched by IFC GlobalId and
 * never by coordinates. A pin on an element that is gone is dropped; a pin on
 * a point of the view (no element) stays. The snapshot does not go along: it
 * is a picture of the Fassung it was taken on, and stays with that viewpoint.
 *
 * What counts as the mark's elements, for „3 von 3 Bauteilen“ and for losing
 * its anchor, is what it points at: the selection and the pinned element.
 * Hidden, shown and coloured elements are filtered the same way but not
 * counted: a view that hid two hundred walls is not about them.
 */

import type { AnnotationViewpointRow } from '@/lib/db/schema/annotation-viewpoints'

/** The fields of a stored viewpoint the carry reads. */
export type CarriedViewpointSource = Pick<
  AnnotationViewpointRow,
  | 'id'
  | 'cameraKind'
  | 'camera'
  | 'clippingPlanes'
  | 'selectionIds'
  | 'defaultVisibility'
  | 'visibilityExceptionIds'
  | 'coloring'
  | 'pinPoint'
  | 'pinGlobalId'
>

/** How many of a mark's elements a Fassung has. */
export interface ElementPresence {
  present: number
  total: number
}

/** The elements a mark points at: its selection and its pinned element, each once. */
export function markElementIds(viewpoint: Pick<CarriedViewpointSource, 'selectionIds' | 'pinGlobalId'>): string[] {
  return [...new Set([...viewpoint.selectionIds, ...(viewpoint.pinGlobalId ? [viewpoint.pinGlobalId] : [])])]
}

/** Every GlobalId the viewpoint names: what the carry asks the new Fassung about. */
export function viewpointElementIds(viewpoint: CarriedViewpointSource): string[] {
  return [
    ...new Set([
      ...markElementIds(viewpoint),
      ...viewpoint.visibilityExceptionIds,
      ...viewpoint.coloring.flatMap((group) => group.globalIds),
    ]),
  ]
}

/** How many of the mark's elements are in `present`. */
export function presenceOf(viewpoint: Pick<CarriedViewpointSource, 'selectionIds' | 'pinGlobalId'>, present: ReadonlySet<string>): ElementPresence {
  const ids = markElementIds(viewpoint)
  return { present: ids.filter((id) => present.has(id)).length, total: ids.length }
}

/**
 * Whether carrying loses the mark's anchor: it pointed at elements and the new
 * Fassung has none of them. A view of the whole model (no selection, no pinned
 * element) never loses it.
 */
export const losesAnchor = (presence: ElementPresence): boolean => presence.total > 0 && presence.present === 0

/** The new viewpoint's values: the same view, the elements the new Fassung has, no snapshot. */
export function carriedViewpointValues(source: CarriedViewpointSource, present: ReadonlySet<string>, id: string) {
  const keep = (ids: readonly string[]) => ids.filter((globalId) => present.has(globalId))
  const pinKept = source.pinPoint !== null && (source.pinGlobalId === null || present.has(source.pinGlobalId))
  return {
    id,
    cameraKind: source.cameraKind,
    camera: source.camera,
    clippingPlanes: source.clippingPlanes,
    selectionIds: keep(source.selectionIds),
    defaultVisibility: source.defaultVisibility,
    visibilityExceptionIds: keep(source.visibilityExceptionIds),
    coloring: source.coloring
      .map((group) => ({ color: group.color, globalIds: keep(group.globalIds) }))
      .filter((group) => group.globalIds.length > 0),
    pinPoint: pinKept ? source.pinPoint : null,
    pinGlobalId: pinKept ? source.pinGlobalId : null,
    snapshotKey: null,
    snapshotContentType: null,
    snapshotBytes: null,
    carriedFromId: source.id,
  }
}
