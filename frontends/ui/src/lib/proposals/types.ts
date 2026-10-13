/**
 * Proposed changes: a change to the workspace Piloti proposes and a person
 * applies, kept as a server object (ADR-0105). The first kind is the file
 * operation (move, rename, create a folder, assign); the card that used to
 * carry it and execute it from the browser (`file_operation_proposal`) now
 * shows this object and asks the server to apply it in the deciding person's
 * session.
 *
 * This file is the CONTRACT the slices build against: the BFF service and
 * routes, the typed client, the agent's internal route, and the card. Change it
 * deliberately, in one commit with every caller.
 */

import { z } from 'zod'

export const PROPOSED_CHANGE_KINDS = ['file_operation'] as const
export type ProposedChangeKind = (typeof PROPOSED_CHANGE_KINDS)[number]

/**
 * `applied`: every item went through. `partially_applied`: at least one did and
 * at least one did not; `results` says which. `failed`: none did.
 */
export const PROPOSED_CHANGE_STATUSES = ['proposed', 'applied', 'partially_applied', 'failed', 'dismissed'] as const
export type ProposedChangeStatus = (typeof PROPOSED_CHANGE_STATUSES)[number]

export const FILE_OPERATIONS = ['move', 'rename', 'create_folder', 'assign'] as const
export type FileOperation = (typeof FILE_OPERATIONS)[number]

/** Most items one proposal carries; mirrors `MAX_FILE_OPERATIONS` in `src/aiq_agent/cards/models.py`. */
export const MAX_FILE_OPERATION_ITEMS = 8

const text = (max: number) => z.string().trim().min(1).max(max)

/**
 * One item, in the vocabulary of the card it replaces (`FileOperationItem` in
 * `cards/models.py`): documents and folders by NAME and PATH, never by id. The
 * agent's inventory has no ids; the deciding person's session resolves the
 * names when the change is applied.
 */
export const fileOperationItemSchema = z
  .object({
    document: text(512).nullish(),
    source: z.enum(['projekt', 'buero']).nullish(),
    current: z.string().max(512).nullish(),
    target_folder: z.string().max(1024).nullish(),
    new_display_name: text(512).nullish(),
    folder_name: text(256).nullish(),
    parent_folder: z.string().max(1024).nullish(),
    member: text(256).nullish(),
  })
  .strict()
export type FileOperationItem = z.infer<typeof fileOperationItemSchema>

export const fileOperationPayloadSchema = z
  .object({
    operation: z.enum(FILE_OPERATIONS),
    operations: z.array(fileOperationItemSchema).min(1).max(MAX_FILE_OPERATION_ITEMS),
    note: z.string().max(500).nullish(),
  })
  .strict()
export type FileOperationPayload = z.infer<typeof fileOperationPayloadSchema>

/** What applying one item did, in words a person reads in the card. */
export const proposedChangeResultSchema = z.object({
  label: z.string(),
  ok: z.boolean(),
  reason: z.string().optional(),
})
export type ProposedChangeResult = z.infer<typeof proposedChangeResultSchema>

/** A proposed change as a person's client reads it. */
export const proposedChangeViewSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string(),
  kind: z.enum(PROPOSED_CHANGE_KINDS),
  payload: fileOperationPayloadSchema,
  status: z.enum(PROPOSED_CHANGE_STATUSES),
  /** Always Piloti today; the column exists so a person's proposal needs no migration. */
  proposedByKind: z.enum(['piloti', 'person']),
  /** The person Piloti acted for: whose turn proposed it. */
  onBehalfOf: z.string(),
  onBehalfOfName: z.string().nullable(),
  originConversationId: z.string().nullable(),
  originMessageId: z.string().nullable(),
  createdAt: z.string(),
  decidedBy: z.string().nullable(),
  decidedByName: z.string().nullable(),
  decidedAt: z.string().nullable(),
  results: z.array(proposedChangeResultSchema).nullable(),
  /** Whether the reader may apply or dismiss it now (status `proposed` and write access to the project). */
  canDecide: z.boolean(),
})
export type ProposedChangeView = z.infer<typeof proposedChangeViewSchema>

/**
 * Person routes:
 *   GET  /api/proposals/[id]          -> { proposal }
 *   POST /api/proposals/[id]/apply    -> { proposal }  (409 unless `proposed`)
 *   POST /api/proposals/[id]/dismiss  -> { proposal }  (409 unless `proposed`)
 * Applying runs every item through the same services the Files pane uses, in
 * the DECIDING person's session, in order, and records `results`.
 */
export const proposalResponseSchema = z.object({ proposal: proposedChangeViewSchema })
export type ProposalResponse = z.infer<typeof proposalResponseSchema>

/**
 * Piloti's side: POST /api/internal/proposals, with the turn's signed envelope
 * echoed. The project is the turn's, never named in the request. Returns the
 * id the card carries.
 */
export const internalProposalRequestSchema = z
  .object({
    op: z.literal('create'),
    kind: z.literal('file_operation'),
    payload: fileOperationPayloadSchema,
    answerMessageId: z.string().uuid().optional(),
  })
  .strict()
export type InternalProposalRequest = z.input<typeof internalProposalRequestSchema>

export const internalProposalResponseSchema = z.object({
  id: z.string().uuid(),
  status: z.enum(PROPOSED_CHANGE_STATUSES),
})
export type InternalProposalResponse = z.infer<typeof internalProposalResponseSchema>
