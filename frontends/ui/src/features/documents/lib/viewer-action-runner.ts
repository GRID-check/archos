/**
 * Carry out one of Piloti's viewer actions on this page (ADR-0144).
 *
 * The action names a document by id and a place on it. Before anything moves,
 * the runner reads the document in the person's own session with
 * `GET /api/documents/{id}` (`document-get`), the read Files and every agent
 * door already use: a second route for the same question would be a second
 * contract (ADR-0055). A 403 or 404 is `refused` and the viewer stays where it
 * was: the event Piloti sent is a proposal, never a key. A comparison reads
 * both documents, at once, and runs only for two Fassungen of one document: on
 * one shelf (`projectId`, `collectionName`) and linked as Fassungen
 * (`revision`, the links a person confirmed).
 *
 * Then it moves the viewer the way the person's own clicks would, so there is
 * one viewer and no second way into it:
 *  - a page, a passage or a box: the chat peek opens the document
 *    (`openFilePeek`, without binding the composer's subject, which stays the
 *    person's choice) and the pane turns to the place (`viewerTarget`). With no
 *    room beside the chat (a phone) the same pane opens over it, as a dialog;
 *  - a comparison: the Fassung comparison the document's own list opens;
 *  - a model element: the model view the element chips link to.
 *
 * Every move hands back its undo, and the undo says whether it put anything
 * back: the viewer as it was, unless the person has opened another document
 * since; the comparison shut, unless another one is open now; the page the
 * person came from, unless they have left the model view already.
 */

import type {
  RefusalReason,
  ViewerActionCall,
  ViewerActionOutcome,
  ViewerActionRunner,
} from '@/features/chat/lib/viewer-actions'
import { buildModelHref, buildOfficeShelfModelHref } from '@/features/bim/lib/model-link'
import { placeRegions } from '@/features/knowledge/lib/page-place'
import type { RevisionLinks } from '@/lib/documents/revision-links'
import type { CompareFile } from '../components/revision-compare/types'
import { toFileItem, type DocumentWireRow } from './file-item'
import { openFilePeek } from './open-file-peek'
import { useFilePreviewStore } from '../stores/file-preview-store'

/** A listing row as `GET /api/documents/{id}` carries it, with its shelf. */
type ReadRow = DocumentWireRow & {
  projectId: string | null
  collectionName?: string | null
  revision?: RevisionLinks | null
}

export interface ViewerActionRunnerDeps {
  /** Whether the peek has room beside the chat now (`peekHasRoom`). */
  hasRoom: () => boolean
  openCompare: (older: CompareFile, newer: CompareFile) => void
  /** Shut the comparison of this pair only; whether it did. */
  closeCompare: (older: CompareFile, newer: CompareFile) => boolean
  /** Go to another page of the app (the model view, and back from it). */
  navigate: (href: string) => void
  /** Where the page is now: path and query. */
  currentHref: () => string
  fetcher?: typeof fetch
}

type Read = { row: ReadRow } | { outcome: ViewerActionOutcome }

const refused = (reason: RefusalReason): ViewerActionOutcome => ({ outcome: 'refused', reason })

/** One document as the person may read it, or the outcome that ends the action. */
async function readDocument(id: string, fetcher: typeof fetch): Promise<Read> {
  let response: Response
  try {
    response = await fetcher(`/api/documents/${encodeURIComponent(id)}`, { headers: { accept: 'application/json' } })
  } catch {
    return { outcome: { outcome: 'failed' } }
  }
  if (response.status === 403 || response.status === 404) return { outcome: refused('unavailable') }
  if (!response.ok) return { outcome: { outcome: 'failed' } }
  const body = (await response.json().catch(() => null)) as { document?: ReadRow } | null
  if (!body?.document || body.document.id !== id) return { outcome: { outcome: 'failed' } }
  return { row: body.document }
}

/** Whether `older` is a Fassung `newer` replaced, by the links a person confirmed. */
const replaces = (newer: ReadRow, older: ReadRow): boolean => {
  const links = newer.revision
  if (links?.history?.some((entry) => entry.id === older.id)) return true
  if (links?.supersedes.some((entry) => entry.id === older.id)) return true
  return older.revision?.supersededBy?.id === newer.id
}

/** The two Fassungen of a comparison, older first; or why there is no comparison of them. */
const pairOf = (first: ReadRow, second: ReadRow): { older: ReadRow; newer: ReadRow } | RefusalReason => {
  const sameShelf =
    first.projectId === second.projectId && (first.collectionName ?? null) === (second.collectionName ?? null)
  if (!sameShelf) return 'notRevisions'
  if (replaces(first, second)) return { older: second, newer: first }
  if (replaces(second, first)) return { older: first, newer: second }
  return 'notRevisions'
}

/** The boxes the viewer marks for a `highlight_region`, in its own frame. */
const regionsOf = (call: ViewerActionCall) => {
  const { region, page, document_id, document_name } = call.args
  if (!region || !page) return null
  return placeRegions({ document: { id: document_id, name: document_name, shelf: 'stored' }, page, frame: 'page', region })
}

/** Open the document at the action's place: beside the chat, or over it without room. */
function openAtPlace(call: ViewerActionCall, row: ReadRow, room: boolean): ViewerActionOutcome {
  const before = useFilePreviewStore.getState()
  const previous = { file: before.file, mode: before.mode, context: before.context, hidden: before.hidden, target: before.viewerTarget }
  openFilePeek({
    file: toFileItem(row),
    source: row.projectId ? 'project' : 'office',
    projectId: row.projectId,
    bindComposerSubject: false,
    // A phone has no room for two panes: the same pane, as a dialog over the chat.
    presentation: room ? 'peek' : 'modal',
  })
  const { page, passage } = call.args
  useFilePreviewStore.getState().setViewerTarget({
    fileId: row.id,
    page: page ?? null,
    passage: call.tool_call_name === 'highlight_passage' ? passage : null,
    regions: call.tool_call_name === 'highlight_region' ? regionsOf(call) : null,
    key: call.tool_call_id,
  })
  const undo = (): boolean => {
    const store = useFilePreviewStore.getState()
    // The person moved on to another document since: leave what they chose.
    if (store.file?.id !== row.id) return false
    if (!previous.file) {
      store.close()
      return true
    }
    store.open(previous.file, previous.mode, previous.context)
    if (previous.hidden) store.hide()
    store.setViewerTarget(previous.target)
    return true
  }
  return { outcome: 'shown', where: room ? 'beside' : 'over', undo }
}

/** Path and query of an in-app href, for comparing where the page is with where an action took it. */
const pathOf = (href: string): string => {
  const url = new URL(href, 'http://in-app.invalid')
  return `${url.pathname}${url.search}`
}

export function createViewerActionRunner(deps: ViewerActionRunnerDeps): ViewerActionRunner {
  const fetcher = deps.fetcher ?? ((input, init) => fetch(input, init))

  const compare = async (call: ViewerActionCall): Promise<ViewerActionOutcome> => {
    const againstId = call.args.against_document_id
    if (!againstId) return refused('notRevisions')
    const [first, second] = await Promise.all([readDocument(call.args.document_id, fetcher), readDocument(againstId, fetcher)])
    if ('outcome' in first) return first.outcome
    if ('outcome' in second) return second.outcome
    const pair = pairOf(first.row, second.row)
    if (typeof pair === 'string') return refused(pair)
    const older = { id: pair.older.id, filename: pair.older.filename }
    const newer = { id: pair.newer.id, filename: pair.newer.filename }
    deps.openCompare(older, newer)
    return { outcome: 'shown', where: 'compare', undo: () => deps.closeCompare(older, newer) }
  }

  const model = (call: ViewerActionCall, row: ReadRow): ViewerActionOutcome => {
    const view = { model: row.filename, element: call.args.element ?? undefined }
    const href = row.projectId ? buildModelHref(row.projectId, view) : buildOfficeShelfModelHref(view)
    const from = deps.currentHref()
    deps.navigate(href)
    const undo = (): boolean => {
      // Only from the model view this action opened: a page the person went on to is theirs.
      if (pathOf(deps.currentHref()) !== pathOf(href)) return false
      deps.navigate(from)
      return true
    }
    return { outcome: 'shown', where: 'model', undo }
  }

  return {
    hasRoom: deps.hasRoom,
    run: async (call) => {
      if (call.tool_call_name === 'compare_revisions') return compare(call)
      const read = await readDocument(call.args.document_id, fetcher)
      if ('outcome' in read) return read.outcome
      if (call.tool_call_name === 'focus_ifc_element') return model(call, read.row)
      return openAtPlace(call, read.row, deps.hasRoom())
    },
  }
}
