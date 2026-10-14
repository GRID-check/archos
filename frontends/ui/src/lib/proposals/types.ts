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
import { ProjectProfilePatchOperationSchema } from '@/lib/project-profile/types'
import { PROJECT_MEMORY_CONFIDENCES, PROJECT_MEMORY_KINDS } from '@/lib/projects/memory-vocabulary'

/**
 * `file_operation`: move, rename, create a folder, assign (0140).
 * `memory`: a note for the project's or the office's memory (0143).
 * `project_profile`: a change to the project's facts, goals, unknowns or
 * assumptions, as a JSON patch on the profile (0143).
 */
export const PROPOSED_CHANGE_KINDS = ['file_operation', 'memory', 'project_profile'] as const
export type ProposedChangeKind = (typeof PROPOSED_CHANGE_KINDS)[number]

/**
 * `applied`: every item went through. `partially_applied`: at least one did and
 * at least one did not; `results` says which. `failed`: none did.
 */
export const PROPOSED_CHANGE_STATUSES = ['proposed', 'applied', 'partially_applied', 'failed', 'dismissed'] as const
export type ProposedChangeStatus = (typeof PROPOSED_CHANGE_STATUSES)[number]

export const FILE_OPERATIONS = ['move', 'rename', 'create_folder', 'assign'] as const
export type FileOperation = (typeof FILE_OPERATIONS)[number]

/**
 * What a proposal changes, as the inbox row words it
 * (`collaboration.inbox.types.pilotiProposalWaiting.variants.<variant>`): a
 * file operation by its verb, every other kind by its kind. Stored on the
 * `piloti.proposal_waiting` item as its `variant` (`./attention.ts`).
 */
export const PROPOSAL_NOTICE_VARIANTS = [...FILE_OPERATIONS, 'memory', 'project_profile'] as const
export type ProposalNoticeVariant = (typeof PROPOSAL_NOTICE_VARIANTS)[number]

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

/** Where a memory note lives: the project's memory, or the whole office's. */
export const MEMORY_SCOPES = ['project', 'organization'] as const
export type MemoryScope = (typeof MEMORY_SCOPES)[number]

/**
 * A note Piloti proposes to remember (`project_memory_remember`, when it may
 * not write it itself). `supersedes` quotes the earlier note it corrects,
 * verbatim, so accepting the correction retires that note
 * (`createProjectMemoryItem`'s `supersedesContent`).
 */
export const memoryPayloadSchema = z
  .object({
    scope: z.enum(MEMORY_SCOPES),
    kind: z.enum(PROJECT_MEMORY_KINDS),
    content: text(500),
    confidence: z.enum(PROJECT_MEMORY_CONFIDENCES),
    supersedes: z.string().trim().max(500).nullish(),
  })
  .strict()
export type MemoryPayload = z.infer<typeof memoryPayloadSchema>

/** Most operations one profile proposal carries. The card draws each one, before and after. */
export const MAX_PROFILE_PATCH_OPERATIONS = 20

/**
 * A change to the project's facts (`project_profile_patch`): the patch is what
 * is applied and what the record says was proposed; the title and rationale
 * are what the reader is told. No preview: the reader's view is derived from
 * the patch against the profile as it is when they look.
 */
export const projectProfilePayloadSchema = z
  .object({
    title: text(200),
    rationale: z.string().trim().max(600).nullish(),
    patch: z.array(ProjectProfilePatchOperationSchema).min(1).max(MAX_PROFILE_PATCH_OPERATIONS),
  })
  .strict()
export type ProjectProfilePayload = z.infer<typeof projectProfilePayloadSchema>

/** What applying one item did, in words a person reads in the card. */
export const proposedChangeResultSchema = z.object({
  label: z.string(),
  ok: z.boolean(),
  reason: z.string().optional(),
  /** What the apply created, when it created something addressable (a memory note's id). */
  itemId: z.string().optional(),
  /**
   * Memory notes only: the memory the note went into. It is the scope the
   * decider's click chose, which is not always the one Piloti asked for in the
   * payload („Nur im Projekt merken“). Absent on a row written before it was
   * recorded, and on every other kind.
   */
  scope: z.enum(MEMORY_SCOPES).optional(),
})
export type ProposedChangeResult = z.infer<typeof proposedChangeResultSchema>

/** The fields every proposed change has, whatever its kind. */
const proposedChangeBaseSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string(),
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
  /**
   * Whether the reader may apply or dismiss it now: status `proposed`, and the
   * right the KIND needs (`project:documents:write` for a file operation,
   * `project:memory:write` for a memory note or a profile change; `project:edit`
   * covers all three).
   */
  canDecide: z.boolean(),
})

/** A proposed change as a person's client reads it, its payload typed by its kind. */
export const proposedChangeViewSchema = z.discriminatedUnion('kind', [
  proposedChangeBaseSchema.extend({ kind: z.literal('file_operation'), payload: fileOperationPayloadSchema }),
  proposedChangeBaseSchema.extend({ kind: z.literal('memory'), payload: memoryPayloadSchema }),
  proposedChangeBaseSchema.extend({ kind: z.literal('project_profile'), payload: projectProfilePayloadSchema }),
])
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
const internalCreateBase = {
  op: z.literal('create'),
  answerMessageId: z.string().uuid().optional(),
  /**
   * Which card of that answer this is. With `answerMessageId` it makes the
   * create idempotent: the same card twice returns the first proposal (0143).
   */
  originCardIndex: z.number().int().min(0).optional(),
}

export const internalProposalRequestSchema = z.discriminatedUnion('kind', [
  z.object({ ...internalCreateBase, kind: z.literal('file_operation'), payload: fileOperationPayloadSchema }).strict(),
  z.object({ ...internalCreateBase, kind: z.literal('memory'), payload: memoryPayloadSchema }).strict(),
  z.object({ ...internalCreateBase, kind: z.literal('project_profile'), payload: projectProfilePayloadSchema }).strict(),
])
export type InternalProposalRequest = z.input<typeof internalProposalRequestSchema>

export const internalProposalResponseSchema = z.object({
  id: z.string().uuid(),
  status: z.enum(PROPOSED_CHANGE_STATUSES),
})
export type InternalProposalResponse = z.infer<typeof internalProposalResponseSchema>

/**
 * `POST /api/proposals/[id]/apply` takes an optional body. For a memory note
 * the deciding person may file it in the project's memory instead of the
 * office's (never the other way: a project note does not become the office's
 * by a click on a proposal that did not ask for it). Ignored for other kinds.
 */
export const applyProposalRequestSchema = z
  .object({ memoryScope: z.literal('project').optional() })
  .strict()
export type ApplyProposalRequest = z.infer<typeof applyProposalRequestSchema>
