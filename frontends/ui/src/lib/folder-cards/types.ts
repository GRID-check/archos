/**
 * The folder card wire contract (ADR-0127): what the Python builder PUTs and
 * what `list_files` reads back. The zod schemas are the source; the JSON Schema
 * in `tests/fixtures/folder-cards.schema.json` is generated from them by
 * `folder-cards-schema.spec.ts` for the Python client (ADR-0055).
 */

import { z } from 'zod'

export const FOLDER_CARD_ABSTRACT_MAX = 600
export const FOLDER_CARD_KEY_FACTS_MAX = 8
export const FOLDER_CARD_STATUSES = ['fresh', 'stale', 'failed'] as const

/** One statement and the documents (by file name) it rests on. */
export const folderCardKeyFactSchema = z
  .object({
    statement: z.string().min(1).max(300),
    documents: z.array(z.string().min(1).max(255)).min(1).max(8),
    pages: z.string().min(1).max(40).optional(),
  })
  .strict()
export type FolderCardKeyFact = z.infer<typeof folderCardKeyFactSchema>

/** The folder is named by its collection and its path inside it; the BFF resolves the id. */
export const putFolderCardRequestSchema = z
  .object({
    organization_id: z.string().min(1),
    collection: z.string().min(1),
    folder_path: z.string().min(1).max(1024),
    abstract: z.string().max(FOLDER_CARD_ABSTRACT_MAX).nullable(),
    key_facts: z.array(folderCardKeyFactSchema).max(FOLDER_CARD_KEY_FACTS_MAX),
    input_hash: z.string().min(1).max(128),
    abstract_hash: z.string().min(1).max(128).nullable(),
    model: z.string().min(1).max(200).nullable(),
    prompt_version: z.string().min(1).max(100).nullable(),
    status: z.enum(FOLDER_CARD_STATUSES),
  })
  .strict()
export type PutFolderCardRequest = z.infer<typeof putFolderCardRequestSchema>

export const getFolderCardsQuerySchema = z
  .object({ organization_id: z.string().min(1), collection: z.string().min(1) })
  .strict()

export const deleteFolderCardQuerySchema = getFolderCardsQuerySchema.extend({
  folder_path: z.string().min(1).max(1024),
})

export const folderCardViewSchema = z.object({
  folder_id: z.string().uuid(),
  folder_path: z.string(),
  /** What a person wrote about the folder; the card complements it, never replaces it. */
  folder_description: z.string().nullable(),
  collection: z.string(),
  abstract: z.string().nullable(),
  key_facts: z.array(folderCardKeyFactSchema),
  input_hash: z.string(),
  abstract_hash: z.string().nullable(),
  model: z.string().nullable(),
  prompt_version: z.string().nullable(),
  status: z.enum(FOLDER_CARD_STATUSES),
  generated_at: z.string().nullable(),
  updated_at: z.string(),
})
export type FolderCardView = z.infer<typeof folderCardViewSchema>

/** A living folder of the collection, card or not: what a person wrote about it, for the builder's first build. */
export const folderDescriptionViewSchema = z.object({
  folder_id: z.string().uuid(),
  folder_path: z.string(),
  folder_description: z.string().nullable(),
})
export type FolderDescriptionView = z.infer<typeof folderDescriptionViewSchema>

export const putFolderCardResponseSchema = z.object({ folder_id: z.string().uuid(), status: z.enum(FOLDER_CARD_STATUSES) })
export type PutFolderCardResponse = z.infer<typeof putFolderCardResponseSchema>

/**
 * `cards`: the cards of the folders whose documents live in the asked collection
 * NOW (computed from the folder tree, never from what the card was written
 * under). `folders`: every such living folder with its description, card or not.
 */
export const getFolderCardsResponseSchema = z.object({
  cards: z.array(folderCardViewSchema),
  folders: z.array(folderDescriptionViewSchema),
})
export type GetFolderCardsResponse = z.infer<typeof getFolderCardsResponseSchema>

export const deleteFolderCardResponseSchema = z.object({ deleted: z.boolean() })

/** Every shape the fixture carries, by the name the Python side looks it up by. */
export const FOLDER_CARD_WIRE_SCHEMAS = {
  PutFolderCardRequest: putFolderCardRequestSchema,
  PutFolderCardResponse: putFolderCardResponseSchema,
  FolderCardView: folderCardViewSchema,
  FolderDescriptionView: folderDescriptionViewSchema,
  GetFolderCardsResponse: getFolderCardsResponseSchema,
} as const
