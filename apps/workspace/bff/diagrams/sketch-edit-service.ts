/**
 * A Skizze edited by operations (S4): the service behind
 * `POST /api/documents/[id]/sketch/edits` (apply), its `/preview` (the
 * picture of the change) and `POST /api/documents/[id]/sketch/revert` (take a
 * Fassung back), and the check Piloti's proposal passes before it is filed.
 *
 * The edit is applied here, on the server, by `applySketchEdit` (pure); what
 * follows is the save every Skizze takes (`saveSketchDocument`): the server's
 * picture (ADR-0149), the two-author marking, the next Fassung or the open
 * Freigabe draft, the PDF beside it, the room's notice, the search row.
 *
 * ## A newer Fassung
 *
 * An edit names the Fassung it was made on (`baseVersionId`). When someone
 * saved since, the edit is applied to the newest one instead, as long as every
 * id it names is still drawn there and none of what it leans on changed
 * (`sketch-edit-rebase.ts`): operations address elements, not a whole scene,
 * so a colleague's change elsewhere does not undo them. When one is gone or
 * changed, nothing is saved and the answer is 409 `sketch_changed`. A
 * colleague's save landing while this one renders is retried once, as a
 * rebase onto it.
 */

import 'server-only'
import { UnprocessableError, ConflictError, NotFoundError } from '@/lib/api/errors'
import type { AuthorizedSession } from '@/lib/auth/types'
import { recordDocumentAccess } from '@/lib/download-log/service'
import { PublishedVersionMovedError } from '@/lib/documents/published-guard'
import { readVersionContent } from '@/lib/documents/version-content'
import { findDocumentVersion, findPreviousVersion } from '@/lib/documents/version-repository'
import { recordSketchEditScore, type SketchEditOutcome } from '@/lib/langfuse/sketch-score'
import { applySketchEdit, idsNamedBy, SketchEditError, type AppliedSketchScene } from './sketch-edit'
import { sketchEditDiffElements } from './sketch-edit-diff'
import { describeWarnings } from './sketch-edit-lints'
import { changedUnderEdit } from './sketch-edit-rebase'
import { saveSketchDocument, sketchSaveBaseOf, sketchSceneOfText, type SketchSaveBase } from './sketch-document'
import { textsToMeasure } from './sketch-picture'
import { sketchRenderer } from './sketch-renderer'
import type { SketchScene } from './sketch-scene'
import { sketchTargetOf } from './sketch-target'
import type { SaveSketchBody, SavedSketch } from './sketch-wire'
import {
  sketchEditSchema,
  type AppliedSketchEdit,
  type DeclinedSketchEdit,
  type SketchEditBody,
  type SketchEditPreview,
  type SketchRevertBody,
} from './sketch-edit-wire'

/** Why an operation was refused, in words the model acts on. */
const REFUSAL_WORDS: Record<string, string> = {
  'too-many-ops': 'more operations than one edit takes; split the change',
  'unknown-id': 'names an element the sketch does not have; read it again with document-sketch-get',
  'id-taken': 'adds an element under an id the sketch already uses; choose a new id',
  'not-a-connector': 'rebinds an element that is no arrow or line',
  'not-movable': 'moves an element a relative operation cannot move (an arrow or a label: move its box instead)',
  'field-not-allowed': 'sets a field this element does not have (`text` is a free text’s, `label` a shape’s, no size for arrows and texts)',
  'bad-color': 'sets a colour that is not #rgb, #rrggbb or transparent',
  'empty-update': 'updates nothing',
  'empty-rebind': 'rebinds neither end',
  'dangling-binding': 'binds to an element that does not exist',
  'bad-intent': 'has no intent, or one longer than 200 characters: one short sentence the person reads',
  'bad-coordinate': 'sets a position or size outside ±10000',
  'too-many-ids': 'names more than 100 elements in one step; split it',
}

/** The sketch moved on and an id the edit names is gone: the 409 the route words in the reader's language. */
export class SketchChangedError extends Error {
  constructor(readonly currentVersionId: string | null) {
    super('sketch_changed')
    this.name = 'SketchChangedError'
  }
}

/** The Fassung to take back is no longer the current one (or a Freigabe is open): the 409 the route words. */
export class SketchMovedOnError extends Error {
  constructor(readonly currentVersionId: string | null) {
    super('moved_on')
    this.name = 'SketchMovedOnError'
  }
}

export function sketchEditRefusalMessage(error: SketchEditError): string {
  const words = REFUSAL_WORDS[error.refusal] ?? `is refused (${error.refusal})`
  return `Operation ${error.opIndex + 1}${error.elementId ? ` (${error.elementId})` : ''} ${words}. Nothing was changed.`
}

/** A checked scene as the save's body holds one; the save checks it again. */
const asSaveScene = (scene: SketchScene): SaveSketchBody['scene'] => ({ ...scene, elements: [...scene.elements] })

const kindsOf = (body: SketchEditBody) => [...new Set(body.ops.map((op) => op.op))].sort().join(',')

function score(base: Pick<SketchSaveBase, 'document'>, outcome: SketchEditOutcome, extra: { refusal?: string; metadata?: Record<string, string | number> } = {}) {
  void recordSketchEditScore({
    organizationId: base.document.organizationId,
    documentId: base.document.id,
    answerRef: base.document.authoredByRef ?? null,
    outcome,
    ...extra,
  })
}

const facts = (body: SketchEditBody, applied: AppliedSketchScene) => ({
  ops: body.ops.length,
  kinds: kindsOf(body),
  warnings: applied.warnings.length + applied.moreWarnings,
  added: applied.diff.added.length,
  removed: applied.diff.removed.length,
  changed: applied.diff.changed.length,
})

/**
 * The edit on the scene it should go onto: `current` when the edit was made
 * on it, or a newer Fassung (a rebase) when every id it names is still drawn
 * there and nothing it leans on changed since (`sketch-edit-rebase.ts`).
 */
async function applyOnto(
  session: AuthorizedSession,
  current: SketchSaveBase,
  body: SketchEditBody
): Promise<{ applied: AppliedSketchScene; rebased: boolean }> {
  const rebased = body.baseVersionId !== current.versionId
  if (rebased) {
    const live = new Set(current.scene.elements.filter((element) => !element.isDeleted).map((element) => element.id))
    if (!idsNamedBy(body.ops).every((id) => live.has(id))) throw new SketchChangedError(current.versionId)
    // An edit made on no Fassung has nothing to compare with; the ids it names are all it can be checked by.
    if (body.baseVersionId) {
      const base = sketchSceneOfText(await readVersionContent(session, current.document.id, body.baseVersionId))
      if (changedUnderEdit(base, current.scene, body.ops).length > 0) throw new SketchChangedError(current.versionId)
    }
  }
  try {
    return { applied: applySketchEdit(current.scene, body.ops), rebased }
  } catch (error) {
    // On a newer Fassung an add whose id was taken meanwhile is the sketch having changed, not a wrong edit.
    if (rebased && error instanceof SketchEditError) throw new SketchChangedError(current.versionId)
    throw error
  }
}

type SavedEdit = Omit<Awaited<ReturnType<typeof saveSketchDocument>>, 'answerRef' | 'pdfOutcome'>

/** One try: the edit applied onto `current` and saved, or `moved` when a newer Fassung was saved meanwhile. */
async function applyAndSave(
  input: EditSketchInput,
  current: SketchSaveBase
): Promise<{ saved: SavedEdit; applied: AppliedSketchScene; rebased: boolean } | 'moved'> {
  let outcome: { applied: AppliedSketchScene; rebased: boolean }
  try {
    outcome = await applyOnto(input.session, current, input.body)
  } catch (error) {
    if (error instanceof SketchEditError) score(current, 'refused', { refusal: error.refusal })
    if (error instanceof SketchChangedError) score(current, 'refused', { refusal: 'sketch_changed' })
    throw error
  }
  try {
    const { answerRef: _ref, pdfOutcome: _pdf, ...saved } = await saveSketchDocument({
      session: input.session,
      documentId: input.documentId,
      body: { scene: asSaveScene(outcome.applied.scene), baseVersionId: current.versionId, baseContentHash: current.contentHash },
      marking: input.marking,
      request: input.request,
    })
    return { saved, ...outcome }
  } catch (error) {
    if (error instanceof PublishedVersionMovedError) return 'moved'
    throw error
  }
}

export interface EditSketchInput {
  session: AuthorizedSession
  documentId: string
  body: SketchEditBody
  /** The two-author line, in the reader's locale (`markingEdited`). */
  marking: string
  request?: Request
}

/** Apply an edit and save it as the next Fassung (or into the open draft). No operations: nothing is saved. */
export async function editSketchDocument(input: EditSketchInput): Promise<AppliedSketchEdit | DeclinedSketchEdit> {
  const { session, body } = input
  if (body.ops.length === 0) {
    if (!body.note) throw new UnprocessableError('An edit needs at least one operation, or a note saying why it changes nothing.', { reason: 'empty-edit' })
    return { declined: true, note: body.note }
  }
  let current = await sketchSaveBaseOf(session, input.documentId, 'write')
  let attempt = await applyAndSave(input, current)
  // A colleague's save landed while this one rendered: read the newer Fassung and apply onto it once more.
  if (attempt === 'moved') {
    current = await sketchSaveBaseOf(session, input.documentId, 'write')
    attempt = await applyAndSave(input, current)
    if (attempt === 'moved') throw new SketchChangedError(current.versionId)
  }
  const { saved, applied, rebased } = attempt
  score(current, rebased ? 'rebased' : 'accepted', { metadata: { ...facts(body, applied), version_number: saved.versionNumber } })
  return {
    documentId: saved.documentId,
    versionId: saved.versionId,
    versionNumber: saved.versionNumber,
    state: saved.state,
    rebased,
    diff: applied.diff,
    warnings: applied.warnings,
    pdfStale: saved.pdfStale,
  }
}

/** The scene an edit was made on: the current one, or the Fassung it names, read as the person (and logged). */
async function sceneOfBase(session: AuthorizedSession, current: SketchSaveBase, baseVersionId: string | null): Promise<{ scene: SketchScene; versionId: string | null }> {
  if (!baseVersionId || baseVersionId === current.versionId) {
    await recordDocumentAccess(session, current.document, 'preview')
    return { scene: current.scene, versionId: current.versionId }
  }
  const text = await readVersionContent(session, current.document.id, baseVersionId)
  return { scene: sketchSceneOfText(text), versionId: baseVersionId }
}

/** The edit's picture and diff on the Fassung it was made on, so a decided card keeps showing what it proposed. */
export async function previewSketchEdit(session: AuthorizedSession, documentId: string, body: SketchEditBody): Promise<SketchEditPreview> {
  const current = await sketchSaveBaseOf(session, documentId, 'read')
  const base = await sceneOfBase(session, current, body.baseVersionId)
  const applied = applySketchEdit(base.scene, body.ops)
  const rendered = await sketchRenderer().render({
    elements: sketchEditDiffElements(base.scene, applied.scene, applied.diff),
    remeasure: textsToMeasure(base.scene, applied.scene),
  })
  return { documentId, baseVersionId: base.versionId ?? '', diff: applied.diff, warnings: applied.warnings, svg: rendered.svg }
}

export interface RevertSketchInput {
  session: AuthorizedSession
  documentId: string
  body: SketchRevertBody
  marking: string
  request?: Request
}

/**
 * Take back the current Fassung: the one before it becomes the next Fassung,
 * as a save of its scene. Refused (`SketchMovedOnError`) when `versionId` is no
 * longer current or a Freigabe round is open: then something came after.
 */
export async function revertSketchDocument(input: RevertSketchInput): Promise<SavedSketch> {
  const { session } = input
  const current = await sketchSaveBaseOf(session, input.documentId, 'write')
  const { document } = current
  const target = await sketchTargetOf(document)
  if (target.kind !== 'published' || document.publishedVersionId !== input.body.versionId) {
    throw new SketchMovedOnError(current.versionId)
  }
  const version = await findDocumentVersion(input.body.versionId, document.id, session.organizationId)
  const previous = version ? await findPreviousVersion(document.id, session.organizationId, version.versionNumber) : null
  if (!previous) throw new NotFoundError('This sketch has no earlier version to go back to.')
  const scene = sketchSceneOfText(await readVersionContent(session, document.id, previous.id))
  const { answerRef: _ref, pdfOutcome: _pdf, ...saved } = await saveSketchDocument({
    session,
    documentId: document.id,
    body: { scene: asSaveScene(scene), baseVersionId: input.body.versionId },
    marking: input.marking,
    request: input.request,
  })
  score(current, 'undone', { metadata: { version_number: saved.versionNumber, restored: previous.versionNumber } })
  return saved
}

/** What the check of a proposal answers: decline it (no ops, a note), or file it with these warnings for the model. */
export interface SketchEditProposalCheck {
  decline?: string
  warnings?: string[]
}

/**
 * Run before Piloti's edit becomes a proposal (`checkProposal`): applied on the
 * scene as the person whose turn it is reads it, so an edit that could only
 * fail is a 422 to Piloti and never a dead card. No operations: nothing is
 * proposed, the note is the answer.
 */
export async function checkSketchEditProposal(
  input: { params?: Record<string, string>; body?: unknown },
  session: AuthorizedSession
): Promise<SketchEditProposalCheck> {
  const body = sketchEditSchema.parse(input.body)
  const current = await sketchSaveBaseOf(session, String(input.params?.id ?? ''), 'read')
  if (body.ops.length === 0) {
    score(current, 'declined')
    return { decline: body.note ?? 'No change proposed.' }
  }
  let applied: AppliedSketchScene
  try {
    applied = (await applyOnto(session, current, body)).applied
  } catch (error) {
    if (error instanceof SketchEditError) {
      score(current, 'refused', { refusal: error.refusal })
      throw new UnprocessableError(sketchEditRefusalMessage(error), { reason: 'sketch-edit-refused', refusal: error.refusal })
    }
    if (error instanceof SketchChangedError) {
      score(current, 'refused', { refusal: 'sketch_changed' })
      throw new ConflictError(
        'The sketch changed since you read it: an element this edit names is gone, or a colleague changed one it names or removes along. Read it again with document-sketch-get and redo the edit.',
        {
          reason: 'sketch_changed',
          currentVersionId: error.currentVersionId,
        }
      )
    }
    throw error
  }
  score(current, 'proposed', { metadata: facts(body, applied) })
  const warnings = describeWarnings(applied.warnings, applied.moreWarnings)
  if (current.target === 'review_open') warnings.push('the sketch is in review: the edit can be applied once the review is decided')
  return { warnings }
}
