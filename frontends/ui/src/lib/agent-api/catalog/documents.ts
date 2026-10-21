/** The documents operations (ADR-0121). See `projects.ts` for the shape and `docs/architecture/agent-surface.md` for the rules. */

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

const documentParams = z.object({
  id: z.string().describe('The document id, from a project document listing or document-search.'),
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
]
