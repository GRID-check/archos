/** The documents operations (ADR-0122). See `projects.ts` for the shape and `docs/architecture/agent-surface.md` for the rules. */

import { z } from 'zod'
import { archiveRequestSchema } from '@/lib/documents/lifecycle-types'
import { byNameRequestSchema } from '@/lib/documents/by-name-types'
import {
  documentFileQuerySchema,
  documentSummaryQuerySchema,
  moveDocumentSchema,
  renameDocumentSchema,
  updateTagsSchema,
} from '@/lib/documents/document-wire'
import { nameProbeRequestSchema } from '@/lib/documents/name-probe-types'
import { DOCUMENT_STATUSES } from '@/lib/documents/document-status'
import { SHELF_SCOPES } from '@/lib/documents/shelf-scope'
import { searchBodyInputSchema, searchBodySchema, searchExportQuerySchema, searchScopeQuerySchema, suggestBodySchema } from '@/lib/search/search-wire'
import type { AgentOperation } from '../operation'
import { MAX_UPLOAD_BYTES, documentUploadFields, uploadBodySchemaWith } from '../upload-wire'

const documentParams = z.object({
  id: z.string().describe('The document id, from document-list or workspace-search.'),
})


/** The cap every upload operation shares (`upload-wire.ts`). */
const SIZE_NOTE = `Up to ${MAX_UPLOAD_BYTES / (1024 * 1024)} MiB per call through the agent door; the document limit of the office applies too.`

const revisionOfField = z
  .string()
  .optional()
  .describe('The id of the older document this file is the new revision of; the service checks the pair.')
const uploadBody = uploadBodySchemaWith({
  scope: z.enum(SHELF_SCOPES).optional(),
  projectId: z.string().optional(),
  folderId: z.string().optional().describe('From project-folder-list or office-shelf-folder-list; omit for the root.'),
  revisionOf: revisionOfField,
  ...documentUploadFields,
})
/** A small text file into a project's root: the multipart body as an agent sends it over MCP. */
const projectUploadExample = {
  body: {
    files: [{ name: 'site-notes.txt', mimeType: 'text/plain', contentBase64: 'U2l0ZSB2aXNpdCAyMSBPY3RvYmVy' }],
    fields: { projectId: '0d7b3a5e-7c1c-4a4e-9a63-6a4a1f5f1c11' },
  },
}
const sessionUploadBody = uploadBodySchemaWith({
  conversationId: z
    .string()
    .min(1)
    .describe('The conversation the file is attached to (`s_` plus a UUID with underscores), from conversation-list.'),
  projectId: z.string().optional().describe('The project of the conversation, only used when the conversation is created by this call.'),
  ...documentUploadFields,
})

export const documentsOperations = [
  {
    name: 'document-get',
    domain: 'documents',
    links: 'document',
    summary: 'Read one document’s listing row',
    description:
      'One document by id, as the shelf lists it: name, folder, tags, reading status, version summary and `projectId` ' +
      '(null on the office shelf). ' +
      'Use document-status to follow ingestion.',
    method: 'GET',
    path: '/api/documents/[id]',
    params: documentParams,
    load: () => import('@/app/api/documents/[id]/route'),
  },
  {
    name: 'document-rename',
    domain: 'documents',
    summary: 'Rename a document',
    description:
      'Set the name Piloti shows for a document (`displayName`); `null` clears it so the file name shows again. ' +
      'The stored file name never changes. Needs write access to the document’s project or shelf.',
    method: 'PATCH',
    path: '/api/documents/[id]',
    params: documentParams,
    body: renameDocumentSchema,
    idempotent: true,
    load: () => import('@/app/api/documents/[id]/route'),
  },
  {
    name: 'document-delete',
    domain: 'documents',
    summary: 'Permanently delete a project document',
    description:
      'Erases a project document, its versions and its indexed text permanently. This cannot be undone, and a legal hold refuses ' +
      'it with a 409. To delete it restorably, call document-bin; to only take it out of the working set, document-archive.',
    method: 'DELETE',
    path: '/api/documents/[id]',
    params: documentParams,
    destructive: true,
    load: () => import('@/app/api/documents/[id]/route'),
  },
  {
    name: 'document-bin',
    domain: 'documents',
    summary: 'Move a project document to the bin',
    description:
      'Deletes a project document restorably: out of every listing and every answer, in the project’s bin until `purgeAfter`. ' +
      'Undo with document-restore. The office shelf has no bin (409).',
    method: 'POST',
    path: '/api/documents/[id]/bin',
    params: documentParams,
    load: () => import('@/app/api/documents/[id]/bin/route'),
  },
  {
    name: 'document-restore',
    domain: 'documents',
    summary: 'Restore a deleted document from the bin',
    description:
      'Undoes deleting a document with document-bin: brings it back to the folder it came from, and reads it again. One that ' +
      'went with its folder is refused (409, `details.folderId`): use project-folder-restore.',
    method: 'POST',
    path: '/api/documents/[id]/restore',
    params: documentParams,
    load: () => import('@/app/api/documents/[id]/restore/route'),
  },
  {
    name: 'document-move',
    domain: 'documents',
    summary: 'Move a document to another folder',
    description:
      'File a document in a folder (`folderId`, from folder-list) or at its shelf’s root with `folderId: null`. ' +
      'Needs write access on the document and on the target folder.',
    method: 'PATCH',
    path: '/api/documents/[id]/folder',
    params: documentParams,
    body: moveDocumentSchema,
    idempotent: true,
    load: () => import('@/app/api/documents/[id]/folder/route'),
  },
  {
    name: 'document-tags-update',
    domain: 'documents',
    summary: 'Set a document’s tags and topics',
    description:
      'Replaces the tags of a document with the given list (an empty list clears them); tags must come from the fixed vocabulary. ' +
      '`topics` is optional: leave it out and the model’s topics stay as they are.',
    method: 'PATCH',
    path: '/api/documents/[id]/tags',
    params: documentParams,
    body: updateTagsSchema,
    idempotent: true,
    load: () => import('@/app/api/documents/[id]/tags/route'),
  },
  {
    name: 'document-archive',
    domain: 'documents',
    summary: 'Archive a document',
    description:
      'Takes a document out of the working set: it leaves the default listings and stops answering questions, but the file ' +
      'and every version stay. Send an empty body. Undo with document-unarchive. Needs write access on the document’s project.',
    method: 'POST',
    path: '/api/documents/[id]/archive',
    params: documentParams,
    body: archiveRequestSchema,
    idempotent: true,
    load: () => import('@/app/api/documents/[id]/archive/route'),
  },
  {
    name: 'document-unarchive',
    domain: 'documents',
    summary: 'Bring an archived document back',
    description:
      'The reverse of document-archive: back in the default listings and read into the index again. Follow ' +
      '`ingest: "queued"` with document-status.',
    method: 'POST',
    path: '/api/documents/[id]/unarchive',
    params: documentParams,
    idempotent: true,
    load: () => import('@/app/api/documents/[id]/unarchive/route'),
  },
  {
    name: 'document-status',
    domain: 'documents',
    summary: 'Read a document’s ingestion status',
    description:
      `Where the document is in reading and indexing: \`status\` is one of ${DOCUMENT_STATUSES.join(', ')}. Poll it after ` +
      'an upload; on `failed` call document-reingest, on a stuck run document-ingest-cancel.',
    method: 'GET',
    path: '/api/documents/[id]/status',
    params: documentParams,
    load: () => import('@/app/api/documents/[id]/status/route'),
  },
  {
    name: 'document-text-get',
    domain: 'documents',
    summary: 'Read a text file’s contents',
    description:
      'The stored text of a plain text, Markdown or CSV document, up to a preview limit (`truncated` says when cut). Any other ' +
      'type answers 415 with where to read it instead.',
    method: 'GET',
    path: '/api/documents/[id]/text',
    params: documentParams,
    load: () => import('@/app/api/documents/[id]/text/route'),
  },
  {
    name: 'document-visual-details-get',
    domain: 'documents',
    summary: 'Read what Piloti saw on a drawing or image',
    description:
      'The visual reading of a drawing or image document: what the vision model found on its pages. ' +
      'Empty for documents that have no visual reading.',
    method: 'GET',
    path: '/api/documents/[id]/visual-details',
    params: documentParams,
    load: () => import('@/app/api/documents/[id]/visual-details/route'),
  },
  {
    name: 'document-model-get',
    domain: 'documents',
    summary: 'Read the building model of an IFC document',
    description:
      'The model record behind an IFC document (processing state and summary), or null when the document is not a model ' +
      'or the IFC feature is off. For model contents use the bim operations.',
    method: 'GET',
    path: '/api/documents/[id]/model',
    params: documentParams,
    load: () => import('@/app/api/documents/[id]/model/route'),
  },
  {
    name: 'document-reingest',
    domain: 'documents',
    summary: 'Read a document again',
    description:
      'Queues the document for ingestion once more, for example after a failed read. Follow it with document-status. ' +
      'Needs write access on the document’s project.',
    method: 'POST',
    path: '/api/documents/[id]/reingest',
    params: documentParams,
    idempotent: true,
    load: () => import('@/app/api/documents/[id]/reingest/route'),
  },
  {
    name: 'document-ingest-cancel',
    domain: 'documents',
    summary: 'Cancel a document’s running ingestion',
    description:
      'Stops a document that is still queued or being read. The document and its file stay; call document-reingest to start over.',
    method: 'POST',
    path: '/api/documents/[id]/cancel',
    params: documentParams,
    idempotent: true,
    load: () => import('@/app/api/documents/[id]/cancel/route'),
  },
  {
    name: 'workspace-search',
    domain: 'documents',
    summary: 'Search everything the person may read, with filters',
    description:
      'Searches every shelf the person may read, or one project (`projectId`), a folder of it (`folderId`) or the office ' +
      'shelf (`scope: office_shelf`). Finds documents by name, by what ingestion read (type, parties, facts, references, ' +
      'drawing number, revision, scale) and by content with the passage and page; also annotations, folders, projects and ' +
      'conversations (`kinds`). `sort` orders like a drawing register, `facets` counts per value, `cursor` pages one kind. ' +
      'A passage points at a page: read the document before quoting it.',
    method: 'POST',
    path: '/api/search',
    query: searchScopeQuerySchema,
    body: searchBodySchema,
    readOnly: true,
    spansProjects: 'unlessScoped',
    load: () => import('@/app/api/search/route'),
  },
  {
    name: 'workspace-search-suggest',
    domain: 'documents',
    summary: 'Complete a search filter from document values',
    description:
      'Values documents in reach hold for one workspace-search filter, starting as `prefix`, with document ' +
      'counts, under the same scope and `filters`. `cites` values are tokens.',
    method: 'POST',
    path: '/api/search/suggest',
    query: searchScopeQuerySchema,
    body: suggestBodySchema,
    readOnly: true,
    spansProjects: 'unlessScoped',
    load: () => import('@/app/api/search/suggest/route'),
  },
  {
    name: 'workspace-search-export',
    domain: 'documents',
    summary: 'Export the documents a search finds as a drawing register file',
    description:
      'The documents of a search (same scope and body as workspace-search) as a drawing register, csv (semicolon) or xlsx, ' +
      'one row per document in the search order. Refused above 5000 documents: narrow the filters.',
    method: 'POST',
    path: '/api/search/export',
    query: searchExportQuerySchema,
    body: searchBodyInputSchema,
    readOnly: true,
    spansProjects: 'unlessScoped',
    binaryResponse: ['text/csv', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
    load: () => import('@/app/api/search/export/route'),
  },
  {
    name: 'document-summary-get',
    domain: 'documents',
    summary: 'Count a shelf’s documents per folder and state',
    description:
      'Counts per folder by reading state for a project (`projectId`) or the office shelf (`scope: office_shelf`), matching ' +
      'what document-list shows, plus the failed documents. Optionally filter by author kind or include archived documents.',
    method: 'GET',
    path: '/api/documents/summary',
    query: documentSummaryQuerySchema,
    load: () => import('@/app/api/documents/summary/route'),
  },
  {
    name: 'document-by-name-resolve',
    domain: 'documents',
    summary: 'Find documents by file name',
    description:
      'Resolves exact file names (case-insensitive) to listing rows on a project (`projectId`) or the office shelf ' +
      '(`scope: office_shelf`). Use it when you know the file name but not the id; names without a match are absent. Read-only.',
    method: 'POST',
    path: '/api/documents/by-name',
    body: byNameRequestSchema,
    readOnly: true,
    load: () => import('@/app/api/documents/by-name/route'),
  },
  {
    name: 'document-name-match',
    domain: 'documents',
    summary: 'Check which file names a shelf already holds',
    description:
      'Before adding files, asks which of the given names a project (`projectId`) or the office shelf (`scope: office_shelf`) ' +
      'already holds, with the existing document’s id, size and content hash so identical bytes can be skipped. Read-only.',
    method: 'POST',
    path: '/api/documents/name-matches',
    body: nameProbeRequestSchema,
    readOnly: true,
    load: () => import('@/app/api/documents/name-matches/route'),
  },

  // ---- Files: presigned links and bytes out, uploads in ----
  {
    name: 'document-download',
    domain: 'documents',
    summary: 'Get a time-limited download link for a document',
    description:
      'Mints a presigned URL for the document’s current file and answers `{ downloadUrl, filename, contentType, fileSize }`. ' +
      'The link expires after a few minutes and was minted for this person: hand it on at once, and call this again for a fresh one. ' +
      'The bytes are not sent here; for a PDF use document-file-get. Records the access.',
    method: 'GET',
    path: '/api/documents/[id]/download',
    params: documentParams,
    load: () => import('@/app/api/documents/[id]/download/route'),
  },
  {
    name: 'document-file-get',
    domain: 'documents',
    summary: 'Read a document’s or a version’s bytes',
    description:
      'The document’s current PDF (a stored PDF, or the PDF rendition of an office document), or with `versionId` that version’s ' +
      'own bytes of any type, as an attached resource (base64 `blob`) up to 5 MiB. A larger file is not sent; ' +
      'document-download gives a link.',
    method: 'GET',
    path: '/api/documents/[id]/file',
    params: documentParams,
    query: documentFileQuerySchema,
    binaryResponse: ['application/pdf', 'application/octet-stream', 'image/*'],
    load: () => import('@/app/api/documents/[id]/file/route'),
  },
  {
    name: 'document-preview-get',
    domain: 'documents',
    summary: 'Get a time-limited preview link for a document',
    description:
      'Presigns an inline preview of the document: `{ url, contentType, filename, imageUrl, rendition }`. An office document is ' +
      'previewed through its PDF rendition. The URL expires (an hour at most); call again for a fresh one. 415 for content that ' +
      'cannot be previewed, 502 `RENDITION_FAILED` when the conversion failed. No bytes are sent here.',
    method: 'GET',
    path: '/api/documents/[id]/preview',
    params: documentParams,
    load: () => import('@/app/api/documents/[id]/preview/route'),
  },
  {
    name: 'document-thumbnail-get',
    domain: 'documents',
    summary: 'Get a document’s thumbnail link',
    description:
      'A time-limited URL of the document’s first-page thumbnail image, `{ url }`, with `url: null` when it has none (not drawn ' +
      'yet, or the file is held by the upload screening). The link expires; no bytes are sent here.',
    method: 'GET',
    path: '/api/documents/[id]/thumbnail',
    params: documentParams,
    load: () => import('@/app/api/documents/[id]/thumbnail/route'),
  },
  {
    name: 'document-upload',
    domain: 'documents',
    summary: 'Upload a file to a project or the office shelf',
    description:
      `Stores one file on a shelf, optionally in a folder, and ingests it. ${SIZE_NOTE} Send \`body.files[0]\` as ` +
      '{ name, mimeType, contentBase64 } and in `body.fields` `projectId` or `scope: office_shelf`. Follow it with document-status.',
    method: 'POST',
    path: '/api/documents/upload',
    body: uploadBody,
    bodyEncoding: 'multipart',
    examples: [projectUploadExample],
    load: () => import('@/app/api/documents/upload/route'),
  },
  {
    name: 'session-document-upload',
    domain: 'documents',
    summary: 'Attach a file to a conversation',
    description:
      `Stores one file privately on one conversation (not in any project shelf) and ingests it for that conversation. ${SIZE_NOTE} ` +
      'Send `body.files[0]` as { name, mimeType, contentBase64 } and `body.fields.conversationId`; the conversation is created ' +
      'when it does not exist yet. Returns `{ documentId, jobId, status, filename }`; follow ingestion with document-status.',
    method: 'POST',
    path: '/api/session/documents/upload',
    body: sessionUploadBody,
    bodyEncoding: 'multipart',
    load: () => import('@/app/api/session/documents/upload/route'),
  },

] as const satisfies readonly AgentOperation[]
