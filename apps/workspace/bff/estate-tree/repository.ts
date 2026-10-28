/**
 * The SQL of the estate tree (`./service.ts`): one shelf's folders, empty ones
 * included, and one keyset page of its documents, each under the reach the
 * search uses (`lib/search/reach.ts`). Who may list what is decided there and
 * only there: folders through `folderReachWhere`, documents through
 * `reachWhere` (the shelves, the hidden folders, the lifecycle,
 * `documentVisibleTo`). What this module adds is the walk: every folder, the
 * card beside it, the page, and what ingestion read of each document from the
 * search's projection (`document_search_facets`).
 *
 * The conversation's own files (the session shelf) are no shelf of a reach, so
 * they are read with the reach's READER and the conversation, nothing more.
 */

import 'server-only'
import { and, asc, eq, gt, or, sql, type SQL } from 'drizzle-orm'
import { BadRequestError } from '@/lib/api/errors'
import { getDb } from '@/lib/db'
import { documentSearchFacets } from '@/lib/db/schema/document-search'
import { documentVersions } from '@/lib/db/schema/document-versions'
import { documents } from '@/lib/db/schema/documents'
import { folderCards } from '@/lib/db/schema/folder-cards'
import { projectFolders } from '@/lib/db/schema/project-folders'
import { shelfFolderWhere, type DocumentShelf } from '@/lib/documents/shelf'
import { documentVisibleTo } from '@/lib/documents/visibility'
import { reachWhere } from '@/lib/search/document-repository'
import { folderReachWhere } from '@/lib/search/providers-repository'
import { reachReader, type SearchReach } from '@/lib/search/reach'
import { ESTATE_TREE_FOLDERS_MAX } from './types'

const f = documentSearchFacets

/** Which documents a page reads: a shelf of the reach, or the conversation's own files under the reach's reader. */
export type TreeSource = { kind: 'reach'; reach: SearchReach } | { kind: 'session'; reach: SearchReach; conversationId: string }

export interface TreeFolderRow {
  id: string
  parentId: string | null
  name: string
  path: string
  description: string | null
  cardStatus: 'fresh' | 'stale' | 'failed' | null
  cardGeneratedAt: Date | null
}

export interface TreeDocumentRow {
  id: string
  filename: string
  displayName: string | null
  folderId: string | null
  folderPath: string | null
  collectionName: string
  contentType: string | null
  fileSize: number | null
  status: string
  authoredBy: string
  documentType: string | null
  pageCount: number | null
  superseded: boolean
  planNumber: string | null
  planIndex: string | null
  planDate: string | null
  publishedVersion: number | null
  versionCount: number
  createdAt: Date
  updatedAt: Date
}

/** Where a page of documents starts: after this file name and id. */
export interface TreeCursor {
  filename: string
  id: string
}

/**
 * The living folder at `path` on the shelf, or null. Only the path's
 * resolution: whether the audience may list it is the reach's (`folderSubtree`
 * refuses a hidden one).
 */
export async function findFolderIdByPath(organizationId: string, shelf: DocumentShelf, path: string): Promise<string | null> {
  const [row] = await getDb()
    .select({ id: projectFolders.id })
    .from(projectFolders)
    .where(and(shelfFolderWhere(shelf, organizationId), eq(projectFolders.path, path)))
    .limit(1)
  return row?.id ?? null
}

/**
 * The reach's folders, by path, at most {@link ESTATE_TREE_FOLDERS_MAX};
 * `truncated` when there were more. Empty folders are listed: nothing here
 * joins a document.
 */
export async function listTreeFolders(reach: SearchReach): Promise<{ rows: TreeFolderRow[]; truncated: boolean }> {
  const rows = await getDb()
    .select({
      id: projectFolders.id,
      parentId: projectFolders.parentId,
      name: projectFolders.name,
      path: projectFolders.path,
      description: projectFolders.description,
      cardStatus: folderCards.status,
      cardGeneratedAt: folderCards.generatedAt,
    })
    .from(projectFolders)
    .leftJoin(folderCards, eq(folderCards.folderId, projectFolders.id))
    .where(folderReachWhere(reach))
    .orderBy(asc(projectFolders.path), asc(projectFolders.id))
    .limit(ESTATE_TREE_FOLDERS_MAX + 1)
  return {
    rows: rows.slice(0, ESTATE_TREE_FOLDERS_MAX).map((row) => ({
      ...row,
      cardGeneratedAt: row.cardGeneratedAt === null ? null : new Date(row.cardGeneratedAt),
    })),
    truncated: rows.length > ESTATE_TREE_FOLDERS_MAX,
  }
}

function sourceWhere(source: TreeSource): SQL | undefined {
  if (source.kind === 'reach') return reachWhere(source.reach, false)
  return and(
    eq(documents.organizationId, source.reach.organizationId),
    eq(documents.scope, 'session'),
    eq(documents.conversationId, source.conversationId),
    eq(documents.lifecycle, 'active'),
    documentVisibleTo(reachReader(source.reach)),
  )
}

/**
 * One page of the source's documents, by file name then id, after `cursor`;
 * `limit + 1` rows are read so the caller knows whether a next page exists.
 */
export async function listTreeDocuments(
  source: TreeSource,
  page: { cursor: TreeCursor | null; limit: number },
): Promise<TreeDocumentRow[]> {
  const versionCount = sql<number>`(
    SELECT count(*) FROM ${documentVersions} AS v
    WHERE v.document_id = ${documents.id} AND v.organization_id = ${documents.organizationId}
  )`
  const rows = await getDb()
    .select({
      id: documents.id,
      filename: documents.filename,
      displayName: documents.displayName,
      folderId: documents.folderId,
      folderPath: projectFolders.path,
      collectionName: documents.collectionName,
      contentType: documents.contentType,
      fileSize: documents.fileSize,
      status: documents.status,
      authoredBy: documents.authoredBy,
      documentType: f.documentType,
      pageCount: f.pageCount,
      superseded: sql<boolean>`coalesce(${f.superseded}, false)`,
      planNumber: f.planNumber,
      planIndex: f.planIndex,
      planDate: f.planDate,
      publishedVersion: documentVersions.versionNumber,
      versionCount,
      createdAt: documents.createdAt,
      updatedAt: documents.updatedAt,
    })
    .from(documents)
    .leftJoin(f, eq(f.documentId, documents.id))
    .leftJoin(projectFolders, eq(projectFolders.id, documents.folderId))
    .leftJoin(
      documentVersions,
      and(eq(documentVersions.id, documents.publishedVersionId), eq(documentVersions.documentId, documents.id)),
    )
    .where(
      and(
        sourceWhere(source),
        page.cursor
          ? or(
              gt(documents.filename, page.cursor.filename),
              and(eq(documents.filename, page.cursor.filename), gt(documents.id, page.cursor.id)),
            )
          : undefined,
      ),
    )
    .orderBy(asc(documents.filename), asc(documents.id))
    .limit(page.limit + 1)
  return rows.map((row) => ({
    ...row,
    fileSize: row.fileSize === null ? null : Number(row.fileSize),
    pageCount: row.pageCount === null ? null : Number(row.pageCount),
    superseded: Boolean(row.superseded),
    planDate: row.planDate === null ? null : String(row.planDate),
    publishedVersion: row.publishedVersion === null ? null : Number(row.publishedVersion),
    versionCount: Number(row.versionCount),
    createdAt: new Date(row.createdAt),
    updatedAt: new Date(row.updatedAt),
  }))
}

/** The cursor as the wire carries it: opaque to the caller. */
export function encodeTreeCursor(cursor: TreeCursor): string {
  return Buffer.from(JSON.stringify([cursor.filename, cursor.id]), 'utf8').toString('base64url')
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** A cursor this route issued, or a 400. */
export function decodeTreeCursor(raw: string): TreeCursor {
  let parsed: unknown = null
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'))
  } catch {
    parsed = null
  }
  if (Array.isArray(parsed) && parsed.length === 2 && typeof parsed[0] === 'string' && typeof parsed[1] === 'string' && UUID.test(parsed[1])) {
    return { filename: parsed[0], id: parsed[1] }
  }
  throw new BadRequestError('cursor is not one this route issued')
}
