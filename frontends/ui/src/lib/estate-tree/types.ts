/**
 * The estate tree's wire contract (ADR-0133 slice 7, `docs/architecture/agent-filesystem.md`
 * §5): one shelf's folders and documents as the conversation's whole audience
 * may LIST them, for the agent's `ls` and `glob`. Exported as JSON Schema to
 * `tests/fixtures/estate-tree.schema.json` (`estate-tree-schema.ts`); the Python
 * client (`aiq_agent/knowledge/estate_tree_client.py`) is tested against that
 * file. There is no Pydantic twin.
 *
 * Snake case, like the folder cards' contract: the Python tier is the reader.
 */

import { z } from 'zod'
import { FOLDER_CARD_STATUSES } from '@/lib/folder-cards/types'

/** The shelves a turn's estate has: the turn's project, the office shelf, the conversation's own files. */
export const ESTATE_SHELVES = ['project', 'office_shelf', 'session'] as const
export type EstateShelf = (typeof ESTATE_SHELVES)[number]

/** Most documents one page carries, and the default. */
export const ESTATE_TREE_PAGE_MAX = 500
export const ESTATE_TREE_PAGE_DEFAULT = 200

/**
 * Most folders one answer lists. A shelf's folders come whole (an empty folder
 * is the point of this route), up to this bound; past it `folders_truncated`
 * says so, and a document row still names its folder's path.
 */
export const ESTATE_TREE_FOLDERS_MAX = 1000

/** A cursor is ours (`next_cursor`), echoed; anything longer is not one. */
const CURSOR_MAX = 1024

export const estateTreeRequestSchema = z
  .object({
    shelf: z.enum(ESTATE_SHELVES),
    /**
     * A folder of the shelf, by its path (`Einreichung/Pläne`): the answer is
     * that folder and everything below it. Absent: the whole shelf. A path with
     * no listable folder (none, deleted, or restricted) is the same 404.
     */
    folder_path: z.string().min(1).max(1024).optional(),
    cursor: z.string().min(1).max(CURSOR_MAX).optional(),
    limit: z.number().int().min(1).max(ESTATE_TREE_PAGE_MAX).optional(),
  })
  .strict()
export type EstateTreeRequest = z.infer<typeof estateTreeRequestSchema>

/** A living folder every reader of the conversation may list, empty or not. */
export const estateTreeFolderSchema = z.object({
  id: z.string().uuid(),
  parent_id: z.string().uuid().nullable(),
  name: z.string(),
  /** Slash-separated from the shelf's root, as `project_folders.path` holds it. */
  path: z.string(),
  /** What a person wrote about the folder. */
  description: z.string().nullable(),
  /** Whether the folder has a card (ADR-0127), and how fresh; its text is `GET /api/internal/folder-cards`. */
  card: z.object({ status: z.enum(FOLDER_CARD_STATUSES), generated_at: z.string().nullable() }).nullable(),
})
export type EstateTreeFolder = z.infer<typeof estateTreeFolderSchema>

/**
 * A document every reader may list. What ingestion read of it (Dokumentart,
 * pages, Plankopf, whether a newer Fassung replaces it) comes from the search's
 * projection (`document_search_facets`), and is null (`superseded` false) for a
 * document the projection has not reached yet.
 */
export const estateTreeDocumentSchema = z.object({
  id: z.string().uuid(),
  /** The immutable identity, the path's leaf (`documents.filename`; `piloti/<name>` for an agent-filed one). */
  filename: z.string(),
  display_name: z.string().nullable(),
  folder_id: z.string().uuid().nullable(),
  folder_path: z.string().nullable(),
  collection: z.string(),
  content_type: z.string().nullable(),
  file_size: z.number().int().nullable(),
  status: z.string(),
  authored_by: z.string(),
  /**
   * The Dokumentart the dossier read (`dossier.document_type`, the search's
   * filter). Not `doc_class`: that one is human-set, lives in the agent's own
   * document record, and wins over this wherever both exist.
   */
  document_type: z.string().nullable(),
  page_count: z.number().int().nullable(),
  /** A newer Fassung replaces it (ADR-0099). */
  superseded: z.boolean(),
  plan_number: z.string().nullable(),
  plan_index: z.string().nullable(),
  plan_date: z.string().nullable(),
  /** The published Fassung's number (`document_versions.version_number`), null before one is published. */
  published_version: z.number().int().nullable(),
  /** How many Fassungen the document has, drafts included. */
  version_count: z.number().int(),
  created_at: z.string(),
  updated_at: z.string(),
})
export type EstateTreeDocument = z.infer<typeof estateTreeDocumentSchema>

export const estateTreeResponseSchema = z.object({
  shelf: z.enum(ESTATE_SHELVES),
  /** The shelf's own collection; a restricted folder's is never named here. */
  collection: z.string(),
  folders: z.array(estateTreeFolderSchema),
  folders_truncated: z.boolean(),
  documents: z.array(estateTreeDocumentSchema),
  /** Send it back as `cursor` for the next page of documents; null on the last. */
  next_cursor: z.string().nullable(),
})
export type EstateTreeResponse = z.infer<typeof estateTreeResponseSchema>

/** Every shape the fixture carries, by the name the Python side looks it up by. */
export const ESTATE_TREE_WIRE_SCHEMAS = {
  EstateTreeRequest: estateTreeRequestSchema,
  EstateTreeFolder: estateTreeFolderSchema,
  EstateTreeDocument: estateTreeDocumentSchema,
  EstateTreeResponse: estateTreeResponseSchema,
} as const
