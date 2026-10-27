/**
 * Rewrite the search rows of named documents from a fresh listing (ADR-0136).
 *
 * A person who just changed what the projection derives (a document's tags or
 * topics, a confirmed or withdrawn Fassung link) finds it in the search at
 * once: the service that wrote the change calls {@link refreshSearchRows} once
 * the write has landed. The backstop (`./shelf-projection.ts`) would catch it
 * within the hour; this is the person's own edit, so it does not wait for that.
 *
 * {@link projectDocuments} is the step both share: read the documents'
 * collections fresh and write the rows of those the listing names.
 */

import 'server-only'
import { collectionFileRef, type CollectionFileRef } from '@/lib/documents/collection-file-ref'
import { readCollectionReadings } from '@/lib/documents/reconcile-status'
import { documentShelf, type DocumentShelf } from '@/lib/documents/shelf'
import { projectReadings, type DocumentReading } from './facets-projector'
import { markShelvesStale, type ProjectionDocument } from './facets-repository'

/** A document as {@link refreshSearchRows} takes it: a `documents` row carries every field. */
export interface SearchRowDocument extends ProjectionDocument {
  scope?: string
  projectId: string | null
}

/**
 * Read `docs` from their collections' listings, fresh, and write their rows;
 * how many rows changed. Throws when a listing is unreadable or came without
 * the reading, so the caller decides between a retry and the backstop.
 */
export async function projectDocuments(organizationId: string, docs: readonly ProjectionDocument[]): Promise<number> {
  const byCollection = new Map<string, Array<{ id: string; ref: CollectionFileRef }>>()
  for (const document of docs) {
    const ref = collectionFileRef(document)
    if (!ref) continue
    const group = byCollection.get(ref.collectionName) ?? []
    group.push({ id: document.id, ref })
    byCollection.set(ref.collectionName, group)
  }
  const readings: DocumentReading[] = []
  for (const [collectionName, entries] of byCollection) {
    const listed = await readCollectionReadings(
      collectionName,
      entries.map((entry) => entry.ref)
    )
    if (!listed) throw new Error(`search projection: listing of ${collectionName} unreadable`)
    for (const entry of entries) {
      const reading = listed.get(entry.ref.filename)
      if (reading) readings.push({ documentId: entry.id, ...reading })
    }
  }
  return projectReadings(organizationId, readings)
}

/**
 * Rewrite the search rows of `docs` after a person changed them. Never throws:
 * the person's write has landed, and a projection that could not follow marks
 * the documents' shelves stale, so the next search queues their refresh.
 */
export async function refreshSearchRows(organizationId: string, docs: readonly SearchRowDocument[]): Promise<void> {
  if (docs.length === 0) return
  try {
    await projectDocuments(organizationId, docs)
  } catch (error) {
    console.warn('[search] refreshing the search rows of edited documents failed', error)
    await markShelvesStale(organizationId, shelvesOf(docs)).catch((staleError: unknown) =>
      console.warn('[search] could not mark the shelves stale', staleError)
    )
  }
}

function shelvesOf(docs: readonly SearchRowDocument[]): DocumentShelf[] {
  const shelves = new Map<string, DocumentShelf>()
  for (const doc of docs) {
    const shelf = documentShelf(doc)
    if (shelf) shelves.set(shelf.kind === 'project' ? shelf.projectId : 'office_shelf', shelf)
  }
  return [...shelves.values()]
}
