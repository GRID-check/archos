/**
 * Carry out one of Piloti's viewer actions on this page (ADR-0144).
 *
 * The action names a document by id and a place on it. Before anything moves,
 * the runner asks the BFF, in the person's own session, whether they may see
 * the document (`GET /api/documents/{id}/viewer-place`, which reads it the way
 * Files does). A 403 or 404 is `refused` and the viewer stays where it was: the
 * event Piloti sent is a proposal, never a key.
 *
 * Then it moves the viewer the way the person's own clicks would, so there is
 * one viewer and no second way into it:
 *  - a page, a passage or a box: the chat peek opens the document
 *    (`openFilePeek`, without binding the composer's subject, which stays the
 *    person's choice) and the pane turns to the place (`viewerTarget`);
 *  - a comparison: the Fassung comparison the document's own list opens;
 *  - a model element: the model view the element chips link to.
 *
 * Every move hands back its undo: the peek as it was (or shut), the comparison
 * shut, the page the person came from.
 */

import type { ViewerActionCall, ViewerActionOutcome, ViewerActionRunner } from '@/features/chat/lib/viewer-actions'
import { buildModelHref, buildOfficeShelfModelHref } from '@/features/bim/lib/model-link'
import { placeRegions } from '@/features/knowledge/lib/page-place'
import type { CompareFile } from '../components/revision-compare/types'
import { toFileItem, type DocumentWireRow } from './file-item'
import { openFilePeek } from './open-file-peek'
import { useFilePreviewStore } from '../stores/file-preview-store'

type PlacedRow = DocumentWireRow & { projectId: string | null }

interface ViewerPlace {
  document: PlacedRow
  against?: PlacedRow
}

export interface ViewerActionRunnerDeps {
  /** Whether the peek has room beside the chat now. */
  hasRoom: () => boolean
  openCompare: (older: CompareFile, newer: CompareFile) => void
  closeCompare: () => void
  /** Leave for another page of the app (the model view); `back` returns. */
  navigate: (href: string) => void
  back: () => void
  fetcher?: typeof fetch
}

const placeUrl = (call: ViewerActionCall): string => {
  const base = `/api/documents/${encodeURIComponent(call.args.document_id)}/viewer-place`
  const against = call.args.against_document_id
  return against ? `${base}?against=${encodeURIComponent(against)}` : base
}

/** The place, or the outcome that ends the action: the BFF refused it, or could not be asked. */
async function readPlace(call: ViewerActionCall, fetcher: typeof fetch): Promise<ViewerPlace | ViewerActionOutcome> {
  let response: Response
  try {
    response = await fetcher(placeUrl(call), { headers: { accept: 'application/json' } })
  } catch {
    return { outcome: 'failed' }
  }
  if (response.status === 403 || response.status === 404) return { outcome: 'refused' }
  if (!response.ok) return { outcome: 'failed' }
  const body = (await response.json().catch(() => null)) as ViewerPlace | null
  if (!body?.document || body.document.id !== call.args.document_id) return { outcome: 'failed' }
  if (call.tool_call_name === 'compare_revisions' && !body.against) return { outcome: 'refused' }
  return body
}

const isOutcome = (value: ViewerPlace | ViewerActionOutcome): value is ViewerActionOutcome => 'outcome' in value

/** The boxes the viewer marks for a `highlight_region`, in its own frame. */
const regionsOf = (call: ViewerActionCall) => {
  const { region, page, document_id, document_name } = call.args
  if (!region || !page) return null
  return placeRegions({ document: { id: document_id, name: document_name, shelf: 'stored' }, page, frame: 'page', region })
}

/** Open the document in the peek at the action's place; the undo puts the peek back as it was. */
function openInPeek(call: ViewerActionCall, row: PlacedRow): ViewerActionOutcome {
  const before = useFilePreviewStore.getState()
  const previous = { file: before.file, mode: before.mode, context: before.context, hidden: before.hidden, target: before.viewerTarget }
  openFilePeek({
    file: toFileItem(row),
    source: row.projectId ? 'project' : 'office',
    projectId: row.projectId,
    bindComposerSubject: false,
  })
  const { page, passage } = call.args
  useFilePreviewStore.getState().setViewerTarget({
    fileId: row.id,
    page: page ?? null,
    passage: call.tool_call_name === 'highlight_passage' ? passage : null,
    regions: call.tool_call_name === 'highlight_region' ? regionsOf(call) : null,
    key: call.tool_call_id,
  })
  const undo = (): void => {
    const store = useFilePreviewStore.getState()
    // The person moved on to another document since: leave what they chose.
    if (store.file?.id !== row.id) return
    if (!previous.file) return store.close()
    store.open(previous.file, previous.mode, previous.context)
    if (previous.hidden) store.hide()
    store.setViewerTarget(previous.target)
  }
  return { outcome: 'shown', undo }
}

export function createViewerActionRunner(deps: ViewerActionRunnerDeps): ViewerActionRunner {
  const fetcher = deps.fetcher ?? ((input, init) => fetch(input, init))
  return {
    hasRoom: deps.hasRoom,
    run: async (call) => {
      const place = await readPlace(call, fetcher)
      if (isOutcome(place)) return place
      const { document, against } = place
      if (call.tool_call_name === 'compare_revisions' && against) {
        deps.openCompare({ id: against.id, filename: against.filename }, { id: document.id, filename: document.filename })
        return { outcome: 'shown', undo: deps.closeCompare }
      }
      if (call.tool_call_name === 'focus_ifc_element') {
        const view = { model: document.filename, element: call.args.element ?? undefined }
        deps.navigate(document.projectId ? buildModelHref(document.projectId, view) : buildOfficeShelfModelHref(view))
        return { outcome: 'shown', undo: deps.back }
      }
      return openInPeek(call, document)
    },
  }
}
