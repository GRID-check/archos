/**
 * The in-app link that opens a model at one Anmerkung's view: the viewer's own
 * `?model=<file name>&mark=<id>` (`ui/features/bim/lib/model-link.ts`, whose
 * `buildModelHref` builds the same string, held equal by its spec). Here
 * because the server writes it too: the agent door and the agent hand a person
 * this link with every mark on a model, so „Zur Ansicht“ is one click from an
 * answer. No `server-only`: the viewer reads the route constants from here.
 */

/** The project's route a model view opens on: Dateien, with `?model=` turning it into the viewer. */
export const MODEL_VIEW_SEGMENT = 'files'

/** The Archiv's counterpart route: not under a project, the same query string. */
export const OFFICE_SHELF_MODEL_PATH = '/app/office-shelf'

/** The path a model view opens on, for a project's document or the Archiv's. */
export const modelViewPath = (projectId: string | null): string =>
  projectId ? `/app/projects/${projectId}/${MODEL_VIEW_SEGMENT}` : OFFICE_SHELF_MODEL_PATH

/**
 * The link to a mark's view on its model, or null for a mark that is not on a
 * model (a page or a Skizze has its own review), or a document on neither a
 * project nor the Archiv.
 */
export function modelMarkHref(
  doc: { projectId: string | null; scope: string; filename: string },
  mark: { id: string; anchorKind: string }
): string | null {
  if (mark.anchorKind !== 'viewpoint') return null
  if (doc.scope === 'project' && !doc.projectId) return null
  if (doc.scope !== 'project' && doc.scope !== 'office_shelf') return null
  const query = new URLSearchParams({ model: doc.filename, mark: mark.id })
  return `${modelViewPath(doc.scope === 'project' ? doc.projectId : null)}?${query.toString()}`
}
