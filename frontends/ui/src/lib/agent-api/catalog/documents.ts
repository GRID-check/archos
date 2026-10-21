/** The documents operations (ADR-0122). See `projects.ts` for the shape and `docs/architecture/agent-surface.md` for the rules. */

import { z } from 'zod'
import { archiveRequestSchema } from '@/lib/documents/lifecycle-types'
import { projectByNameRequestSchema } from '@/lib/documents/by-name-types'
import {
  documentSummaryQuerySchema,
  moveDocumentSchema,
  renameDocumentSchema,
  searchDocumentsSchema,
  updateTagsSchema,
} from '@/lib/documents/document-wire'
import { projectNameProbeRequestSchema } from '@/lib/documents/name-probe-types'
import type { AgentOperation } from '../operation'
import { MAX_UPLOAD_BYTES, documentUploadFields, uploadBodySchemaWith } from '../upload-wire'

const documentParams = z.object({
  id: z.string().describe('The document id, from a project document listing or document-search.'),
})

const versionFileParams = documentParams.extend({
  versionId: z.string().describe('The version id, from document-version-list.'),
})

/** The cap every upload operation shares (`upload-wire.ts`). */
const SIZE_NOTE = `Up to ${MAX_UPLOAD_BYTES / (1024 * 1024)} MiB per call through the agent door; the document limit of the office applies too.`

const revisionOfField = z
  .string()
  .optional()
  .describe('The id of the older document this file is the new revision of; the service checks the pair.')
const projectUploadBody = uploadBodySchemaWith({
  projectId: z.string().min(1).describe('The project id, from project-list.'),
  folderId: z.string().optional().describe('The folder id, from project-folder-list; omit for the project root.'),
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
const officeShelfUploadBody = uploadBodySchemaWith({
  folderId: z.string().optional().describe('The office shelf folder id, from office-shelf-folder-list; omit for the root.'),
  revisionOf: revisionOfField,
  ...documentUploadFields,
})
const sessionUploadBody = uploadBodySchemaWith({
  conversationId: z
    .string()
    .min(1)
    .describe('The conversation the file is attached to (`s_` plus a UUID with underscores), from conversation-list.'),
  projectId: z.string().optional().describe('The project of the conversation, only used when the conversation is created by this call.'),
  ...documentUploadFields,
})

export const documentsOperations: readonly AgentOperation[] = [
  {
    name: 'document-get',
    domain: 'documents',
    summary: 'Read one document’s listing row',
    description:
      'One document by id, as the shelf lists it: name, folder, tags, reading status and version summary. ' +
      'Use document-status to follow ingestion and document-text-get for what the file says.',
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
      'Erases a project document, its versions and its indexed text. This cannot be undone, and a legal hold refuses it with a 409. ' +
      'To only take a document out of the working set, call document-archive instead.',
    method: 'DELETE',
    path: '/api/documents/[id]',
    params: documentParams,
    destructive: true,
    load: () => import('@/app/api/documents/[id]/route'),
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
      'and every version stay. Send an empty body. Needs write access on the document’s project.',
    method: 'POST',
    path: '/api/documents/[id]/archive',
    params: documentParams,
    body: archiveRequestSchema,
    idempotent: true,
    load: () => import('@/app/api/documents/[id]/archive/route'),
  },
  {
    name: 'document-status',
    domain: 'documents',
    summary: 'Read a document’s ingestion status',
    description:
      'Where the document is in reading and indexing (queued, processing, ready, failed, held). Poll it after an upload; ' +
      'on a failure call document-reingest, on a stuck run document-ingest-cancel.',
    method: 'GET',
    path: '/api/documents/[id]/status',
    params: documentParams,
    load: () => import('@/app/api/documents/[id]/status/route'),
  },
  {
    name: 'document-text-get',
    domain: 'documents',
    summary: 'Read the extracted text of a document',
    description:
      'A preview of the text Piloti extracted from the document. Use it to see what a file says without opening the file; ' +
      'it is empty until document-status reports the document as read.',
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
    name: 'document-search',
    domain: 'documents',
    summary: 'Search a project’s documents by meaning',
    description:
      'Semantic search over the documents of one project (`projectId`, from project-list) for a question or phrase `q`. ' +
      'Returns the best matching passages with their documents, up to `topK` (default set by the server). Read-only.',
    method: 'POST',
    path: '/api/documents/search',
    body: searchDocumentsSchema,
    readOnly: true,
    load: () => import('@/app/api/documents/search/route'),
  },
  {
    name: 'document-summary-get',
    domain: 'documents',
    summary: 'Count a project’s documents by state',
    description:
      'Totals for a project’s shelf (how many documents, in which reading state), matching what the listing shows. ' +
      'Optionally filter by author kind or include archived documents.',
    method: 'GET',
    path: '/api/documents/summary',
    query: documentSummaryQuerySchema,
    load: () => import('@/app/api/documents/summary/route'),
  },
  {
    name: 'document-by-name-resolve',
    domain: 'documents',
    summary: 'Find a project’s documents by file name',
    description:
      'Resolves exact file names to the project’s listing rows (`projectId` from project-list, up to the server’s name limit). ' +
      'Use it when you know the file name but not the id. Read-only.',
    method: 'POST',
    path: '/api/documents/by-name',
    body: projectByNameRequestSchema,
    readOnly: true,
    load: () => import('@/app/api/documents/by-name/route'),
  },
  {
    name: 'document-name-match',
    domain: 'documents',
    summary: 'Check which file names already exist in a project',
    description:
      'Before adding files, asks which of the given names a project already holds, with the existing document’s id, size and ' +
      'content hash so identical bytes can be skipped. Read-only.',
    method: 'POST',
    path: '/api/documents/name-matches',
    body: projectNameProbeRequestSchema,
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
      'The bytes are not sent here; for a PDF use document-file-get, for the text use document-text-get. Records the access.',
    method: 'GET',
    path: '/api/documents/[id]/download',
    params: documentParams,
    load: () => import('@/app/api/documents/[id]/download/route'),
  },
  {
    name: 'document-file-get',
    domain: 'documents',
    summary: 'Read a stored PDF’s bytes',
    description:
      'The document’s PDF itself (a stored PDF, or the PDF rendition of an office document), returned as an attached resource ' +
      '(base64 `blob`) up to 5 MiB. A larger file is not sent: read it in pages with document-text-get or get a link with ' +
      'document-download. Only PDFs are served here.',
    method: 'GET',
    path: '/api/documents/[id]/file',
    params: documentParams,
    binaryResponse: ['application/pdf'],
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
    name: 'document-version-file-get',
    domain: 'documents',
    summary: 'Read the file bytes of one version',
    description:
      'The bytes of one version (the approval record of one revision) of a document under its name, from document-version-list: returned as an attached resource ' +
      '(base64 `blob`) up to 5 MiB; a larger file is not sent, read its text with document-text-get instead. `download: "1"` marks it ' +
      'as an attachment. Only published or superseded versions are served.',
    method: 'GET',
    path: '/api/documents/[id]/versions/[versionId]/file',
    params: versionFileParams,
    query: z.object({ download: z.literal('1').optional().describe('Send 1 to ask for the file as a download.') }),
    binaryResponse: ['application/octet-stream', 'application/pdf', 'image/*'],
    load: () => import('@/app/api/documents/[id]/versions/[versionId]/file/route'),
  },
  {
    name: 'document-upload',
    domain: 'documents',
    summary: 'Upload a file to a project',
    description:
      `Stores one file in a project (optionally in a folder) and hands it to ingestion. ${SIZE_NOTE} ` +
      'Send `body.files[0]` as { name, mimeType, contentBase64 } and the route’s text parts in `body.fields` (`projectId` required). ' +
      'Returns the stored document; ingestion runs in the background, follow it with document-status. A file the screening holds ' +
      'comes back held, and a reviewer allows it. Needs write access to the project’s documents.',
    method: 'POST',
    path: '/api/documents/upload',
    body: projectUploadBody,
    bodyEncoding: 'multipart',
    examples: [projectUploadExample],
    load: () => import('@/app/api/documents/upload/route'),
  },
  {
    name: 'office-shelf-document-upload',
    domain: 'documents',
    summary: 'Upload a file to the office shelf',
    description:
      `Stores one file in the office shelf (optionally in one of its folders) and ingests it into the shared collection. ${SIZE_NOTE} ` +
      'Send `body.files[0]` as { name, mimeType, contentBase64 }. Needs the right to manage the office shelf. Returns the stored document; ' +
      'follow ingestion with document-status.',
    method: 'POST',
    path: '/api/office-shelf/documents/upload',
    body: officeShelfUploadBody,
    bodyEncoding: 'multipart',
    load: () => import('@/app/api/office-shelf/documents/upload/route'),
  },
  {
    name: 'session-document-upload',
    domain: 'documents',
    summary: 'Attach a file to a conversation',
    description:
      `Stores one file privately on one conversation (not in any project shelf) and ingests it for that conversation. ${SIZE_NOTE} ` +
      'Send `body.files[0]` as { name, mimeType, contentBase64 } and `body.fields.conversationId`; the conversation is created ' +
      'when it does not exist yet. Returns the stored document; follow ingestion with document-status.',
    method: 'POST',
    path: '/api/session/documents/upload',
    body: sessionUploadBody,
    bodyEncoding: 'multipart',
    load: () => import('@/app/api/session/documents/upload/route'),
  },

]
