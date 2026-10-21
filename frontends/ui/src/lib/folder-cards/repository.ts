/**
 * The folder cards (ADR-0127, migration 0180). The only module that talks to
 * `folder_cards`. Every function runs inside a tenant scope the caller opened
 * with the organization it names (`withTenant`), so row-level security, not only
 * the WHERE, keeps another office's cards out.
 */

import 'server-only'
import { and, asc, eq, isNull } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { folderCards, projectFolders, projects } from '@/lib/db/schema'
import { officeShelfCollectionNames } from '@/lib/office-shelf/collection'
import { normalizeFolderPath } from '@/lib/projects/folders'
import type { FolderCardView, PutFolderCardRequest } from './types'

/** A restricted folder's own collection: `<project collection>_r<12 hex>` (ADR-0087). */
const RESTRICTED_SUFFIX = /_r[0-9a-f]{12}$/

/** Cards one read returns. Past this the listing is cut, so a runaway tree cannot flood a turn. */
export const FOLDER_CARDS_LIMIT = 1_000

export interface CardFolder {
  folderId: string
  scope: 'project' | 'office_shelf'
}

/**
 * The folder a collection and a path name, inside `organizationId`; null when the
 * collection is not the organization's, or no living folder has that path.
 *
 * A collection is the office shelf's, a project's, or a restricted folder's
 * inside a project (its name is the project's plus a suffix): the first two are
 * exact names, the third resolves to its project.
 */
export async function findCardFolder(
  organizationId: string,
  collection: string,
  folderPath: string,
): Promise<CardFolder | null> {
  const path = normalizeFolderPath(folderPath)
  if (!path) return null
  const db = getDb()
  const owner = await resolveCollectionOwner(organizationId, collection)
  if (!owner) return null
  const [row] = await db
    .select({ id: projectFolders.id })
    .from(projectFolders)
    .where(
      and(
        eq(projectFolders.organizationId, organizationId),
        eq(projectFolders.scope, owner.scope),
        owner.projectId ? eq(projectFolders.projectId, owner.projectId) : isNull(projectFolders.projectId),
        eq(projectFolders.path, path),
        isNull(projectFolders.deletedAt),
      ),
    )
    .limit(1)
  return row ? { folderId: row.id, scope: owner.scope } : null
}

async function resolveCollectionOwner(
  organizationId: string,
  collection: string,
): Promise<{ scope: 'project' | 'office_shelf'; projectId: string | null } | null> {
  if (officeShelfCollectionNames(organizationId).includes(collection)) {
    return { scope: 'office_shelf', projectId: null }
  }
  const db = getDb()
  for (const name of new Set([collection, collection.replace(RESTRICTED_SUFFIX, '')])) {
    const [project] = await db
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.collectionName, name), eq(projects.organizationId, organizationId)))
      .limit(1)
    if (project) return { scope: 'project', projectId: project.id }
  }
  return null
}

/** Write the folder's card, replacing what was there: one card per folder. */
export async function upsertFolderCard(
  organizationId: string,
  folder: CardFolder,
  body: PutFolderCardRequest,
): Promise<void> {
  const db = getDb()
  const now = new Date()
  const values = {
    collection: body.collection,
    abstract: body.abstract,
    keyFacts: body.key_facts,
    inputHash: body.input_hash,
    abstractHash: body.abstract_hash,
    model: body.model,
    promptVersion: body.prompt_version,
    status: body.status,
    generatedAt: body.status === 'fresh' ? now : null,
    updatedAt: now,
  }
  await db
    .insert(folderCards)
    .values({ organizationId, folderId: folder.folderId, scope: folder.scope, ...values })
    .onConflictDoUpdate({ target: folderCards.folderId, set: values })
}

/** The collection's cards with the folder's path and its person-written description; living folders only. */
export async function getFolderCards(organizationId: string, collection: string): Promise<FolderCardView[]> {
  const db = getDb()
  const rows = await db
    .select({
      folderId: folderCards.folderId,
      folderPath: projectFolders.path,
      folderDescription: projectFolders.description,
      collection: folderCards.collection,
      abstract: folderCards.abstract,
      keyFacts: folderCards.keyFacts,
      inputHash: folderCards.inputHash,
      abstractHash: folderCards.abstractHash,
      model: folderCards.model,
      promptVersion: folderCards.promptVersion,
      status: folderCards.status,
      generatedAt: folderCards.generatedAt,
      updatedAt: folderCards.updatedAt,
    })
    .from(folderCards)
    .innerJoin(projectFolders, eq(projectFolders.id, folderCards.folderId))
    .where(
      and(
        eq(folderCards.organizationId, organizationId),
        eq(folderCards.collection, collection),
        isNull(projectFolders.deletedAt),
      ),
    )
    .orderBy(asc(projectFolders.path))
    .limit(FOLDER_CARDS_LIMIT)
  return rows.map((row) => ({
    folder_id: row.folderId,
    folder_path: row.folderPath,
    folder_description: row.folderDescription,
    collection: row.collection,
    abstract: row.abstract,
    key_facts: row.keyFacts,
    input_hash: row.inputHash,
    abstract_hash: row.abstractHash,
    model: row.model,
    prompt_version: row.promptVersion,
    status: row.status,
    generated_at: row.generatedAt ? new Date(row.generatedAt).toISOString() : null,
    updated_at: new Date(row.updatedAt).toISOString(),
  }))
}

/** Remove a folder's card; false when it had none. */
export async function deleteFolderCard(organizationId: string, folder: CardFolder): Promise<boolean> {
  const db = getDb()
  const removed = await db
    .delete(folderCards)
    .where(and(eq(folderCards.organizationId, organizationId), eq(folderCards.folderId, folder.folderId)))
    .returning({ id: folderCards.id })
  return removed.length > 0
}
