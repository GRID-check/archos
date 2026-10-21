/**
 * The folders, documents, uploads and holds operations (ADR-0121). See `projects.ts` for the shape
 * and `docs/architecture/agent-surface.md` for the rules.
 *
 * Left out on purpose: multipart uploads and binary downloads (the dispatcher sends JSON), the mail
 * import's byte-stream protocol, and folder access, which stays with a person.
 */

import { z } from 'zod'
import { projectMarksQuerySchema } from '@/lib/annotations/project-types'
import { createHoldSchema } from '@/lib/compliance/hold-wire'
import { declareDocumentRoleSchema } from '@/lib/document-roles/role-wire'
import { officeShelfByNameRequestSchema } from '@/lib/documents/by-name-types'
import {
  createFolderSchema,
  ensureFoldersSchema,
  updateFolderSchema,
} from '@/lib/documents/folder-wire'
import {
  documentListFilterSchema,
  documentSummaryFilterSchema,
  projectDocumentListQuerySchema,
} from '@/lib/documents/list-query'
import { officeShelfNameProbeRequestSchema } from '@/lib/documents/name-probe-types'
import { searchOfficeShelfSchema } from '@/lib/office-shelf/search-wire'
import {
  openUploadBatchSchema,
  sealUploadBatchSchema,
  uploadHistoryQuerySchema,
} from '@/lib/upload-batches/batch-wire'
import type { AgentOperation } from '../operation'

const projectParams = z.object({ id: z.string().describe('The project id, from project-list.') })
const folderParams = projectParams.extend({
  folderId: z
    .string()
    .describe('The folder id, from project-folder-list or project-folder-bin-list.'),
})
const officeFolderParams = z.object({
  folderId: z.string().describe('The Büroablage folder id, from office-shelf-folder-list.'),
})
const officeDocumentParams = z.object({
  id: z.string().describe('The Büroablage document id, from office-shelf-document-list.'),
})
const bindingParams = projectParams.extend({
  bindingId: z.string().describe('The role binding id, from document-role-list.'),
})
const mailImportParams = projectParams.extend({
  importId: z.string().describe('The mail import id, from mail-import-list.'),
})
const batchParams = z.object({
  id: z.string().describe('The upload batch id, the uuid given to upload-batch-open.'),
})
const holdParams = z.object({ id: z.string().describe('The legal hold id, from hold-list.') })

export const foldersOperations: readonly AgentOperation[] = [
  {
    name: 'project-folder-list',
    domain: 'folders',
    summary: 'List a project’s folders',
    description:
      "Every folder of the project's Dateien that the person may read, each with its id, name, parent, " +
      "path and the person's own access, plus `rootAccess` (what they may do at the project root). " +
      'Folder ids from here feed project-folder-update, project-folder-delete, document filters ' +
      '(`folderId` of project-document-list) and the `parentId` of project-folder-create.',
    method: 'GET',
    path: '/api/projects/[id]/folders',
    params: projectParams,
    load: () => import('@/app/api/projects/[id]/folders/route'),
  },
  {
    name: 'project-folder-create',
    domain: 'folders',
    summary: 'Create a folder in a project',
    description:
      'Creates one folder under `parentId` (null or absent: the project root). Refused with a message ' +
      'when a sibling already has the name; to get-or-create whole paths use project-folder-ensure. ' +
      'Returns `{ folder }`. Needs write access on the parent folder.',
    method: 'POST',
    path: '/api/projects/[id]/folders',
    params: projectParams,
    body: createFolderSchema,
    load: () => import('@/app/api/projects/[id]/folders/route'),
  },
  {
    name: 'project-folder-ensure',
    domain: 'folders',
    summary: 'Resolve folder paths, creating the missing',
    description:
      'Takes directory paths (relative to `parentId`, null: the project root) and returns the folders ' +
      'plus `folderIdByPath`, creating whatever is missing. Unlike project-folder-create it treats an ' +
      'existing folder as success, so call it before filing documents into a tree. Safe to repeat.',
    method: 'POST',
    path: '/api/projects/[id]/folders/ensure',
    params: projectParams,
    body: ensureFoldersSchema,
    idempotent: true,
    load: () => import('@/app/api/projects/[id]/folders/ensure/route'),
  },
  {
    name: 'project-folder-update',
    domain: 'folders',
    summary: 'Rename, move or describe a project folder',
    description:
      "Changes a folder's `name`, its `parentId` (null moves it to the project root) or its " +
      '`description` (null clears it); send only what changes. Folder ids come from ' +
      'project-folder-list. A move that changes who can open the subtree also needs project:manage. ' +
      'Returns `{ folder }`.',
    method: 'PATCH',
    path: '/api/projects/[id]/folders/[folderId]',
    params: folderParams,
    body: updateFolderSchema,
    idempotent: true,
    load: () => import('@/app/api/projects/[id]/folders/[folderId]/route'),
  },
  {
    name: 'project-folder-delete',
    domain: 'folders',
    summary: 'Move a project folder to the bin',
    description:
      "Moves the folder with its subfolders and documents to the project's Papierkorb. It stays " +
      'restorable (project-folder-restore) until the `purgeAfter` date the response names, then is ' +
      'purged. Returns `{ documentsBinned, foldersBinned, purgeAfter }`. Needs write access on the ' +
      'folder and everything below it.',
    method: 'DELETE',
    path: '/api/projects/[id]/folders/[folderId]',
    params: folderParams,
    load: () => import('@/app/api/projects/[id]/folders/[folderId]/route'),
  },
  {
    name: 'project-folder-bin-list',
    domain: 'folders',
    summary: 'List a project’s deleted folders',
    description:
      "The project's Papierkorb: the deleted folders the person may read, who deleted each and when, " +
      'when its purge runs, and what the person may do about it (restore, purge now). Folder ids from ' +
      'here feed project-folder-restore and project-folder-bin-purge.',
    method: 'GET',
    path: '/api/projects/[id]/bin',
    params: projectParams,
    load: () => import('@/app/api/projects/[id]/bin/route'),
  },
  {
    name: 'project-folder-restore',
    domain: 'folders',
    summary: 'Restore a folder from the bin',
    description:
      'Brings a deleted folder back with its access, subfolders and documents. The response says ' +
      "`restoredTo: 'root'` when its former parent no longer exists. Folder ids come from " +
      'project-folder-bin-list.',
    method: 'POST',
    path: '/api/projects/[id]/bin/[folderId]/restore',
    params: folderParams,
    load: () => import('@/app/api/projects/[id]/bin/[folderId]/restore/route'),
  },
  {
    name: 'project-folder-bin-purge',
    domain: 'folders',
    summary: 'Purge a folder from the bin now',
    description:
      'Deletes a binned folder for good, with its subfolders and documents, instead of waiting for the ' +
      'grace period. This cannot be undone. Needs project:manage; a legal hold refuses it with 409 ' +
      'without naming the hold. Folder ids come from project-folder-bin-list.',
    method: 'DELETE',
    path: '/api/projects/[id]/bin/[folderId]',
    params: folderParams,
    destructive: true,
    load: () => import('@/app/api/projects/[id]/bin/[folderId]/route'),
  },
  {
    name: 'office-shelf-folder-list',
    domain: 'folders',
    summary: 'List the Büroablage folders',
    description:
      'Every folder of the office-wide Büroablage (office shelf), in the same shape as ' +
      'project-folder-list. Any member may read. Folder ids feed office-shelf-folder-update, ' +
      'office-shelf-folder-delete and the `folderId` filter of office-shelf-document-list.',
    method: 'GET',
    path: '/api/office-shelf/folders',
    load: () => import('@/app/api/office-shelf/folders/route'),
  },
  {
    name: 'office-shelf-folder-create',
    domain: 'folders',
    summary: 'Create a Büroablage folder',
    description:
      'Creates one folder under `parentId` (null or absent: the shelf root). Needs ' +
      'org:office_shelf:manage. Refused when a sibling has the name; use office-shelf-folder-ensure to ' +
      'get-or-create paths. Returns `{ folder }`.',
    method: 'POST',
    path: '/api/office-shelf/folders',
    body: createFolderSchema,
    load: () => import('@/app/api/office-shelf/folders/route'),
  },
  {
    name: 'office-shelf-folder-ensure',
    domain: 'folders',
    summary: 'Resolve Büroablage folder paths, creating the missing',
    description:
      'Takes directory paths (relative to `parentId`, null: the shelf root), returns the folders plus ' +
      '`folderIdByPath`, and creates whatever is missing. An existing folder counts as success. Needs ' +
      'org:office_shelf:manage. Safe to repeat.',
    method: 'POST',
    path: '/api/office-shelf/folders/ensure',
    body: ensureFoldersSchema,
    idempotent: true,
    load: () => import('@/app/api/office-shelf/folders/ensure/route'),
  },
  {
    name: 'office-shelf-folder-update',
    domain: 'folders',
    summary: 'Rename, move or describe a Büroablage folder',
    description:
      "Changes a folder's `name`, `parentId` (null moves it to the shelf root) or `description` (null " +
      'clears it); send only what changes. Folder ids come from office-shelf-folder-list. Needs ' +
      'org:office_shelf:manage. Returns `{ folder }`.',
    method: 'PATCH',
    path: '/api/office-shelf/folders/[folderId]',
    params: officeFolderParams,
    body: updateFolderSchema,
    idempotent: true,
    load: () => import('@/app/api/office-shelf/folders/[folderId]/route'),
  },
  {
    name: 'office-shelf-folder-delete',
    domain: 'folders',
    summary: 'Delete a Büroablage folder',
    description:
      'Deletes the folder; its documents and subfolders are re-filed one level up, not deleted. Returns ' +
      '`{ documentsMoved, foldersMoved }`. Folder ids come from office-shelf-folder-list. Needs ' +
      'org:office_shelf:manage.',
    method: 'DELETE',
    path: '/api/office-shelf/folders/[folderId]',
    params: officeFolderParams,
    load: () => import('@/app/api/office-shelf/folders/[folderId]/route'),
  },
  {
    name: 'project-document-list',
    domain: 'documents',
    summary: 'List a project’s documents',
    description:
      "One page of the project's documents with name, folder, author, lifecycle and version state. Pass " +
      '`projectId` (from project-list). Without level parameters it drains the whole shelf, 500 a page; ' +
      '`folderId` (a folder id or `root`), `sort`, `dir`, `q`, `state` or `limit` read one folder level ' +
      'instead. Follow `nextCursor` (pass it as `cursor`) until it is null.',
    method: 'GET',
    path: '/api/documents',
    query: projectDocumentListQuerySchema,
    load: () => import('@/app/api/documents/route'),
  },
  {
    name: 'office-shelf-document-list',
    domain: 'documents',
    summary: 'List Büroablage documents',
    description:
      'One page of the office-wide Büroablage documents, same rows and filters as project-document-list ' +
      'but without `projectId`: `folderId`, `sort`, `dir`, `q`, `state`, `limit`, `includeArchived`, ' +
      '`authoredBy`. Follow `nextCursor` (pass it as `cursor`) until it is null. Document ids from here ' +
      'feed the document operations.',
    method: 'GET',
    path: '/api/office-shelf/documents',
    query: documentListFilterSchema,
    load: () => import('@/app/api/office-shelf/documents/route'),
  },
  {
    name: 'office-shelf-document-summary',
    domain: 'documents',
    summary: 'Count Büroablage documents per folder',
    description:
      'What the database can say about every Büroablage document at once: counts per folder by ' +
      'read-state family, plus the failed documents. Cheaper than paging office-shelf-document-list ' +
      'when you need an overview.',
    method: 'GET',
    path: '/api/office-shelf/documents/summary',
    query: documentSummaryFilterSchema,
    load: () => import('@/app/api/office-shelf/documents/summary/route'),
  },
  {
    name: 'office-shelf-document-lookup',
    domain: 'documents',
    summary: 'Find Büroablage documents by file name',
    description:
      'Resolves exact file names (case-insensitive) to their Büroablage document rows. Use it when you ' +
      'have names, for example from a citation, and need ids. Names without a match are simply absent ' +
      'from `documents`.',
    method: 'POST',
    path: '/api/office-shelf/documents/by-name',
    body: officeShelfByNameRequestSchema,
    readOnly: true,
    load: () => import('@/app/api/office-shelf/documents/by-name/route'),
  },
  {
    name: 'office-shelf-document-name-probe',
    domain: 'documents',
    summary: 'Check which file names the Büroablage holds',
    description:
      'Given file names about to be uploaded, returns the Büroablage documents that already carry them. ' +
      'Call it before an upload to avoid duplicates. Changes nothing.',
    method: 'POST',
    path: '/api/office-shelf/documents/name-matches',
    body: officeShelfNameProbeRequestSchema,
    readOnly: true,
    load: () => import('@/app/api/office-shelf/documents/name-matches/route'),
  },
  {
    name: 'office-shelf-document-revision-probe',
    domain: 'documents',
    summary: 'Find documents a file name would revise',
    description:
      'Given dropped file names, returns the Büroablage documents each would be the next Fassung of, so ' +
      'the upload can file it as a new version instead of a second document. Changes nothing.',
    method: 'POST',
    path: '/api/office-shelf/documents/revision-candidates',
    body: officeShelfNameProbeRequestSchema,
    readOnly: true,
    load: () => import('@/app/api/office-shelf/documents/revision-candidates/route'),
  },
  {
    name: 'office-shelf-document-search',
    domain: 'documents',
    summary: 'Search the Büroablage by meaning',
    description:
      "Document-centric semantic search over the office's shared Büroablage. `q` is a natural-language " +
      "query, `topK` (1 to 100) caps the hits. Returns the best matching documents. For the project's " +
      'own documents use the knowledge operations.',
    method: 'POST',
    path: '/api/office-shelf/documents/search',
    body: searchOfficeShelfSchema,
    readOnly: true,
    load: () => import('@/app/api/office-shelf/documents/search/route'),
  },
  {
    name: 'office-shelf-document-delete',
    domain: 'documents',
    summary: 'Delete a Büroablage document',
    description:
      'Deletes one Büroablage document for good: its stored file, its search chunks and its record. ' +
      'This cannot be undone. Needs org:office_shelf:manage. Document ids come from ' +
      'office-shelf-document-list.',
    method: 'DELETE',
    path: '/api/office-shelf/documents/[id]',
    params: officeDocumentParams,
    load: () => import('@/app/api/office-shelf/documents/[id]/route'),
  },
  {
    name: 'document-role-list',
    domain: 'documents',
    summary: 'List a project’s document roles',
    description:
      'The role bindings of the project (which document is the Baugenehmigung, the Lageplan and so on) ' +
      'in `roles`, plus `missing`: the roles Piloti expects the project to hold and does not. Binding ' +
      'ids feed document-role-clear.',
    method: 'GET',
    path: '/api/projects/[id]/document-roles',
    params: projectParams,
    load: () => import('@/app/api/projects/[id]/document-roles/route'),
  },
  {
    name: 'document-role-declare',
    domain: 'documents',
    summary: 'Declare a document’s role in a project',
    description:
      "Binds `documentId` to a `role` of the project's vocabulary (optionally for one " +
      "`scopeInstanceId`). Your call counts as a person's confirmation. Returns the binding. Document " +
      'ids come from project-document-list.',
    method: 'POST',
    path: '/api/projects/[id]/document-roles',
    params: projectParams,
    body: declareDocumentRoleSchema,
    load: () => import('@/app/api/projects/[id]/document-roles/route'),
  },
  {
    name: 'document-role-clear',
    domain: 'documents',
    summary: 'Clear a document-role binding',
    description:
      'Removes one role binding; the document itself stays. Binding ids come from document-role-list. ' +
      'Declare the role again with document-role-declare.',
    method: 'DELETE',
    path: '/api/projects/[id]/document-roles/[bindingId]',
    params: bindingParams,
    load: () => import('@/app/api/projects/[id]/document-roles/[bindingId]/route'),
  },
  {
    name: 'mail-import-list',
    domain: 'documents',
    summary: 'List a project’s mail imports',
    description:
      "The project's Outlook archive imports with their status and counts. Import ids feed " +
      'mail-import-get and mail-import-cancel.',
    method: 'GET',
    path: '/api/projects/[id]/mail-imports',
    params: projectParams,
    load: () => import('@/app/api/projects/[id]/mail-imports/route'),
  },
  {
    name: 'mail-import-get',
    domain: 'documents',
    summary: 'Read one mail import',
    description:
      'One Outlook archive import, as the upload plan: which parts the store already holds. Use it to ' +
      'check progress or to resume a send that broke off. Import ids come from mail-import-list.',
    method: 'GET',
    path: '/api/projects/[id]/mail-imports/[importId]',
    params: mailImportParams,
    load: () => import('@/app/api/projects/[id]/mail-imports/[importId]/route'),
  },
  {
    name: 'mail-import-cancel',
    domain: 'documents',
    summary: 'Cancel a mail import',
    description:
      'Cancels an import and discards the parts already sent. Only the person who started it, or an org ' +
      'project administrator, may cancel. Import ids come from mail-import-list.',
    method: 'DELETE',
    path: '/api/projects/[id]/mail-imports/[importId]',
    params: mailImportParams,
    load: () => import('@/app/api/projects/[id]/mail-imports/[importId]/route'),
  },
  {
    name: 'project-upload-list',
    domain: 'documents',
    summary: 'List a project’s upload history',
    description:
      'Who brought how many files into the project when, and how each upload ended, one page at a time; ' +
      'follow `nextCursor` (pass it as `cursor`) until it is null. Per-file detail is in ' +
      'upload-batch-get, which only the uploader may read.',
    method: 'GET',
    path: '/api/projects/[id]/uploads',
    params: projectParams,
    query: uploadHistoryQuerySchema,
    load: () => import('@/app/api/projects/[id]/uploads/route'),
  },
  {
    name: 'upload-batch-open',
    domain: 'documents',
    summary: 'Open an upload batch',
    description:
      'Announces an upload before its first file: pass a fresh uuid `id`, the `scope` (project, ' +
      'office_shelf or session), `projectId` for a project upload, and `expectedCount`. The server then ' +
      'knows when all files are read and keeps the upload history. Seal it with upload-batch-seal after ' +
      'the last file.',
    method: 'POST',
    path: '/api/upload-batches',
    body: openUploadBatchSchema,
    load: () => import('@/app/api/upload-batches/route'),
  },
  {
    name: 'upload-batch-seal',
    domain: 'documents',
    summary: 'Seal an upload batch',
    description:
      'Closes an upload batch after the last file: `unchanged` and `failed` count the files that wrote ' +
      'no row, `excluded` the names the screening refused as terms and counts. Only the uploader may ' +
      'seal. The id is the one given to upload-batch-open.',
    method: 'POST',
    path: '/api/upload-batches/[id]/seal',
    params: batchParams,
    body: sealUploadBatchSchema,
    load: () => import('@/app/api/upload-batches/[id]/seal/route'),
  },
  {
    name: 'upload-batch-get',
    domain: 'documents',
    summary: 'Read one upload’s summary',
    description:
      'What arrived in one upload, where it was filed, what each file is and what was held back and ' +
      'why. Only the uploader may read it; anyone else is answered as if it did not exist.',
    method: 'GET',
    path: '/api/upload-batches/[id]',
    params: batchParams,
    load: () => import('@/app/api/upload-batches/[id]/route'),
  },
  {
    name: 'quarantine-list',
    domain: 'documents',
    summary: 'List the quarantine queue',
    description:
      'Documents the content check held back that the person may release or delete: org admins see the ' +
      "organization's queue, project admins their projects' part, everyone else an empty `items` list.",
    method: 'GET',
    path: '/api/quarantine',
    load: () => import('@/app/api/quarantine/route'),
  },
  {
    name: 'hold-list',
    domain: 'documents',
    summary: 'List open legal holds',
    description:
      'The open legal holds of the organization, each with its entity, reason and id. Needs the ' +
      'compliance permission. Hold ids feed hold-release.',
    method: 'GET',
    path: '/api/holds',
    load: () => import('@/app/api/holds/route'),
  },
  {
    name: 'hold-create',
    domain: 'documents',
    summary: 'Place a legal hold',
    description:
      'Preserves an entity (`entityType` project, document, conversation, organization, user or folder, ' +
      'and its `entityId`) and blocks its purge, with a `reason`. Needs the compliance permission. ' +
      'Returns the hold; lift it with hold-release.',
    method: 'POST',
    path: '/api/holds',
    body: createHoldSchema,
    load: () => import('@/app/api/holds/route'),
  },
  {
    name: 'hold-release',
    domain: 'documents',
    summary: 'Release a legal hold',
    description:
      'Lifts a legal hold so the held data can be purged again on its normal schedule. Needs the ' +
      'compliance permission. Hold ids come from hold-list.',
    method: 'POST',
    path: '/api/holds/[id]/release',
    params: holdParams,
    destructive: true,
    load: () => import('@/app/api/holds/[id]/release/route'),
  },
  {
    name: 'deletion-list',
    domain: 'documents',
    summary: 'List pending and failed deletions',
    description:
      "The organization's pending and failed deletions behind the Recently deleted view; failed rows " +
      'are purges that got stuck. Needs the compliance permission.',
    method: 'GET',
    path: '/api/deletions',
    load: () => import('@/app/api/deletions/route'),
  },
  {
    name: 'project-annotation-list',
    domain: 'review',
    summary: 'List a project’s open points',
    description:
      "The project's Offene Punkte: the live Anmerkungen across every document the person may see, a " +
      'page at a time. Filter with `status` (open, proposed, all-live), `assignee` (me or a user id), ' +
      '`due` (overdue, soon) and `order`; follow `nextCursor` (pass it as `cursor`).',
    method: 'GET',
    path: '/api/projects/[id]/annotations',
    params: projectParams,
    query: projectMarksQuerySchema,
    load: () => import('@/app/api/projects/[id]/annotations/route'),
  },
]
