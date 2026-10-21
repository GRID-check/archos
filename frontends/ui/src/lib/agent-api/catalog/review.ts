/** The review operations (ADR-0121). See `projects.ts` for the shape and `docs/architecture/agent-surface.md` for the rules. */

import { z } from 'zod'
import {
  createAnnotationRequestSchema,
  createReplyRequestSchema,
  documentThreadRequestSchema,
  updateAnnotationRequestSchema,
  updateReplyRequestSchema,
} from '@/lib/annotations/types'
import { revisionLinkSchema } from '@/lib/documents/document-wire'
import {
  approveRequestSchema,
  forkDraftRequestSchema,
  refuseRequestSchema,
  replaceContentRequestSchema,
  submitRequestSchema,
} from '@/lib/documents/lifecycle-types'
import { projectRevisionCandidatesRequestSchema } from '@/lib/documents/name-probe-types'
import { revisionCompareBodySchema } from '@/lib/documents/revision-compare-types'
import type { AgentOperation } from '../operation'

const documentParams = z.object({
  id: z.string().describe('The document id, from a project document listing or document-search.'),
})

const versionParams = documentParams.extend({
  versionId: z.string().describe('The version id, from document-version-list.'),
})

const annotationParams = documentParams.extend({
  annotationId: z.string().describe('The annotation id, from annotation-list.'),
})

const replyParams = annotationParams.extend({
  replyId: z.string().describe('The reply id, from the annotation’s `replies` in annotation-get.'),
})

/**
 * `GET …/versions/diff` reads `from` and `to` straight off the URL (the route
 * has no query schema), so this one is written for the agent; the route
 * answers 400 when either is missing.
 */
const versionDiffQuery = z.object({
  from: z.string().describe('The version id to compare from, from document-version-list.'),
  to: z.string().describe('The version id to compare to, from document-version-list.'),
})

export const reviewOperations: readonly AgentOperation[] = [
  // ---- Versions: the document lifecycle (draft, in review, approved, published) ----
  {
    name: 'document-version-list',
    domain: 'review',
    summary: 'List a document’s versions',
    description:
      'Every version (Fassung) of a document with its lifecycle state, author and content hash. ' +
      'Start here to get a `versionId` for the other document-version operations.',
    method: 'GET',
    path: '/api/documents/[id]/versions',
    params: documentParams,
    load: () => import('@/app/api/documents/[id]/versions/route'),
  },
  {
    name: 'document-version-fork',
    domain: 'review',
    summary: 'Start a new draft from the published version',
    description:
      'Forks an editable draft from the document’s published version and returns it. Send an empty body. ' +
      'Next: document-version-content-replace to write the draft, then document-version-submit to send it to review.',
    method: 'POST',
    path: '/api/documents/[id]/versions',
    params: documentParams,
    body: forkDraftRequestSchema,
    load: () => import('@/app/api/documents/[id]/versions/route'),
  },
  {
    name: 'document-version-get',
    domain: 'review',
    summary: 'Read one version’s state',
    description:
      'One version of a document: lifecycle state, author, reviewers, decisions and `contentHash` (the `ifMatch` value for edits and decisions).',
    method: 'GET',
    path: '/api/documents/[id]/versions/[versionId]',
    params: versionParams,
    load: () => import('@/app/api/documents/[id]/versions/[versionId]/route'),
  },
  {
    name: 'document-version-content-get',
    domain: 'review',
    summary: 'Read the text of a version',
    description: 'The full text of one version of a draft-type document, as plain text. Use document-version-diff to compare two versions.',
    method: 'GET',
    path: '/api/documents/[id]/versions/[versionId]/content',
    params: versionParams,
    load: () => import('@/app/api/documents/[id]/versions/[versionId]/content/route'),
  },
  {
    name: 'document-version-content-replace',
    domain: 'review',
    summary: 'Replace the text of a draft version',
    description:
      'Writes the whole body of a draft version. `ifMatch` is the `contentHash` you last read (document-version-get); a mismatch is a 409 ' +
      'and nothing is overwritten. Only drafts are editable. Next: document-version-submit.',
    method: 'PUT',
    path: '/api/documents/[id]/versions/[versionId]/content',
    params: versionParams,
    body: replaceContentRequestSchema,
    load: () => import('@/app/api/documents/[id]/versions/[versionId]/content/route'),
  },
  {
    name: 'document-version-diff',
    domain: 'review',
    summary: 'Compare the text of two versions',
    description:
      'Returns both versions (state and full text) side by side so you can see what changed between `from` and `to`. ' +
      'Both ids come from document-version-list.',
    method: 'GET',
    path: '/api/documents/[id]/versions/diff',
    params: documentParams,
    query: versionDiffQuery,
    load: () => import('@/app/api/documents/[id]/versions/diff/route'),
  },
  {
    name: 'document-version-reviewer-list',
    domain: 'review',
    summary: 'List who can be asked to review a document',
    description:
      'The colleagues who hold edit rights on the document’s project and can be named as reviewers. ' +
      'Their user ids go into `reviewerUserIds` of document-version-submit.',
    method: 'GET',
    path: '/api/documents/[id]/versions/reviewers',
    params: documentParams,
    load: () => import('@/app/api/documents/[id]/versions/reviewers/route'),
  },
  {
    name: 'document-version-submit',
    domain: 'review',
    summary: 'Send a draft version to review',
    description:
      'Submits a draft for review. `reviewerUserIds` names who is asked (from document-version-reviewer-list; empty asks the item’s assignees), ' +
      '`orderMessage` is the one-sentence order and `dueAt` an optional date. Reviewers then call document-version-approve, -reject or -request-changes.',
    method: 'POST',
    path: '/api/documents/[id]/versions/[versionId]/submit',
    params: versionParams,
    body: submitRequestSchema,
    load: () => import('@/app/api/documents/[id]/versions/[versionId]/submit/route'),
  },
  {
    name: 'document-version-approve',
    domain: 'review',
    summary: 'Approve a version under review',
    description:
      'Records the reviewer’s approval of a version in review. `ifMatch` is the `contentHash` the reviewer read; a mismatch is a 409. ' +
      'Next: document-version-publish makes an approved version current.',
    method: 'POST',
    path: '/api/documents/[id]/versions/[versionId]/approve',
    params: versionParams,
    body: approveRequestSchema,
    load: () => import('@/app/api/documents/[id]/versions/[versionId]/approve/route'),
  },
  {
    name: 'document-version-reject',
    domain: 'review',
    summary: 'Reject a version under review',
    description:
      'Refuses a version in review. A `comment` saying why is required; `ifMatch` is the `contentHash` the reviewer read.',
    method: 'POST',
    path: '/api/documents/[id]/versions/[versionId]/reject',
    params: versionParams,
    body: refuseRequestSchema,
    load: () => import('@/app/api/documents/[id]/versions/[versionId]/reject/route'),
  },
  {
    name: 'document-version-request-changes',
    domain: 'review',
    summary: 'Ask for changes on a version under review',
    description:
      'Sends a version in review back for rework. A `comment` is required; set `delegateRevision` to hand the rework to Piloti as a task ' +
      'instead of leaving it with the author.',
    method: 'POST',
    path: '/api/documents/[id]/versions/[versionId]/changes',
    params: versionParams,
    body: refuseRequestSchema,
    load: () => import('@/app/api/documents/[id]/versions/[versionId]/changes/route'),
  },
  {
    name: 'document-version-publish',
    domain: 'review',
    summary: 'Publish an approved version',
    description:
      'Makes an approved version the document’s current published Fassung; the previous published version is superseded. Send no body.',
    method: 'POST',
    path: '/api/documents/[id]/versions/[versionId]/publish',
    params: versionParams,
    load: () => import('@/app/api/documents/[id]/versions/[versionId]/publish/route'),
  },

  // ---- Annotations: marks and their threads on a document ----
  {
    name: 'annotation-list',
    domain: 'review',
    summary: 'List the annotations on a document',
    description:
      'Every Anmerkung (mark) on the document with its place, status, assignee and replies, including Piloti’s open proposals. ' +
      'The ids feed annotation-get, annotation-update and annotation-reply-create.',
    method: 'GET',
    path: '/api/documents/[id]/annotations',
    params: documentParams,
    load: () => import('@/app/api/documents/[id]/annotations/route'),
  },
  {
    name: 'annotation-create',
    domain: 'review',
    summary: 'Place an annotation on a document',
    description:
      'Sets a new mark at a place on the document (page position or text range, as the schema describes) with a kind and a body. ' +
      'Returns the annotation with its number. Colleagues named in `mentions` are told.',
    method: 'POST',
    path: '/api/documents/[id]/annotations',
    params: documentParams,
    body: createAnnotationRequestSchema,
    load: () => import('@/app/api/documents/[id]/annotations/route'),
  },
  {
    name: 'annotation-get',
    domain: 'review',
    summary: 'Read one annotation with its thread',
    description: 'One Anmerkung with its whole reply thread, status and carry links (id from annotation-list).',
    method: 'GET',
    path: '/api/documents/[id]/annotations/[annotationId]',
    params: annotationParams,
    load: () => import('@/app/api/documents/[id]/annotations/[annotationId]/route'),
  },
  {
    name: 'annotation-update',
    domain: 'review',
    summary: 'Change, resolve or reassign an annotation',
    description:
      'Edits a mark: reword it, assign it, set a due day, or move its status (open, resolved, dismissed). Send at least one field. ' +
      '`expectedStatus` guards against overwriting a colleague’s change; `carryToCurrent` carries an open mark onto the current Fassung.',
    method: 'PATCH',
    path: '/api/documents/[id]/annotations/[annotationId]',
    params: annotationParams,
    body: updateAnnotationRequestSchema,
    load: () => import('@/app/api/documents/[id]/annotations/[annotationId]/route'),
  },
  {
    name: 'annotation-delete',
    domain: 'review',
    summary: 'Delete one of your own annotations',
    description:
      'Removes a mark its author set. A mark that has been discussed or carried to another Fassung is refused with a 409; resolve it instead ' +
      '(annotation-update). Deleting cannot be undone.',
    method: 'DELETE',
    path: '/api/documents/[id]/annotations/[annotationId]',
    params: annotationParams,
    destructive: true,
    load: () => import('@/app/api/documents/[id]/annotations/[annotationId]/route'),
  },
  {
    name: 'annotation-reply-create',
    domain: 'review',
    summary: 'Reply in an annotation’s thread',
    description:
      'Adds a reply to an annotation. Set `addressesPiloti` or mention Piloti to ask it to answer. Returns the annotation with its thread.',
    method: 'POST',
    path: '/api/documents/[id]/annotations/[annotationId]/replies',
    params: annotationParams,
    body: createReplyRequestSchema,
    load: () => import('@/app/api/documents/[id]/annotations/[annotationId]/replies/route'),
  },
  {
    name: 'annotation-reply-update',
    domain: 'review',
    summary: 'Reword one of your own replies',
    description:
      'Rewords a reply its author wrote, while the mark is live and Piloti has not taken it up (otherwise a 409). Returns the annotation with its thread.',
    method: 'PATCH',
    path: '/api/documents/[id]/annotations/[annotationId]/replies/[replyId]',
    params: replyParams,
    body: updateReplyRequestSchema,
    idempotent: true,
    load: () => import('@/app/api/documents/[id]/annotations/[annotationId]/replies/[replyId]/route'),
  },
  {
    name: 'annotation-reply-delete',
    domain: 'review',
    summary: 'Take back one of your own replies',
    description:
      'Deletes a reply its author wrote, while the mark is live and Piloti has not taken it up (otherwise a 409). It cannot be undone.',
    method: 'DELETE',
    path: '/api/documents/[id]/annotations/[annotationId]/replies/[replyId]',
    params: replyParams,
    destructive: true,
    load: () => import('@/app/api/documents/[id]/annotations/[annotationId]/replies/[replyId]/route'),
  },
  {
    name: 'document-thread-ensure',
    domain: 'review',
    summary: 'Open the caller’s chat thread about a document',
    description:
      'Returns the id of the caller’s own conversation about this document, creating it (with an optional `title`) the first time. ' +
      'Use the conversation operations with that id to read or post in it.',
    method: 'POST',
    path: '/api/documents/[id]/thread',
    params: documentParams,
    body: documentThreadRequestSchema,
    idempotent: true,
    load: () => import('@/app/api/documents/[id]/thread/route'),
  },

  // ---- Quarantine: an upload held back by screening ----
  {
    name: 'document-quarantine-get',
    domain: 'review',
    summary: 'Read why a document is held and who may release it',
    description:
      'For a document held by upload screening: the reason and what the caller may do (request release, or release it as a reviewer). ' +
      'Next: document-quarantine-release-request or document-quarantine-release.',
    method: 'GET',
    path: '/api/documents/[id]/quarantine',
    params: documentParams,
    load: () => import('@/app/api/documents/[id]/quarantine/route'),
  },
  {
    name: 'document-quarantine-release-request',
    domain: 'review',
    summary: 'Ask a reviewer to release a held upload',
    description:
      'The uploader asks the project’s reviewers to release their held file. Notifies the reviewers; changes nothing about the file itself. Send no body.',
    method: 'POST',
    path: '/api/documents/[id]/quarantine/request-release',
    params: documentParams,
    idempotent: true,
    load: () => import('@/app/api/documents/[id]/quarantine/request-release/route'),
  },
  {
    name: 'document-quarantine-release',
    domain: 'review',
    summary: 'Release a quarantined document',
    description:
      'A reviewer lets a held file through screening so it is read and shown like any other document. Needs the reviewer permission ' +
      '(see document-quarantine-get). Send no body; the release is recorded and cannot be taken back.',
    method: 'POST',
    path: '/api/documents/[id]/quarantine/release',
    params: documentParams,
    destructive: true,
    load: () => import('@/app/api/documents/[id]/quarantine/release/route'),
  },

  // ---- Fassungen: how one document replaces another ----
  {
    name: 'document-revision-compare',
    domain: 'review',
    summary: 'Compare a document visually with the one it replaces',
    description:
      'Marks what changed on one page between the older document (`older`, an id) and this newer one: boxed regions plus short sentences. ' +
      'Read-only; both documents must be readable and screened. Candidates for `older` come from document-revision-candidates.',
    method: 'POST',
    path: '/api/documents/[id]/revision-compare',
    params: documentParams,
    body: revisionCompareBodySchema,
    readOnly: true,
    load: () => import('@/app/api/documents/[id]/revision-compare/route'),
  },
  {
    name: 'document-revision-link-set',
    domain: 'review',
    summary: 'Confirm or take back a Fassung link',
    description:
      'States that this document replaces `older` (`linked: true`) or takes that link back (`linked: false`). ' +
      'Both documents must be in the same collection and the caller needs write access.',
    method: 'PUT',
    path: '/api/documents/[id]/revision',
    params: documentParams,
    body: revisionLinkSchema,
    load: () => import('@/app/api/documents/[id]/revision/route'),
  },
  {
    name: 'document-revision-candidates',
    domain: 'review',
    summary: 'Find documents a new file could replace',
    description:
      'For file names about to be added to a project (`projectId`, `names`, optional target `folders`), lists existing documents each ' +
      'could be a new Fassung of. Read-only; feeds document-revision-link-set.',
    method: 'POST',
    path: '/api/documents/revision-candidates',
    body: projectRevisionCandidatesRequestSchema,
    readOnly: true,
    load: () => import('@/app/api/documents/revision-candidates/route'),
  },
]
