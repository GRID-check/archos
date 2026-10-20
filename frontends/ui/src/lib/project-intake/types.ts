/**
 * Projekterfassung: Piloti sets a project up from its documents (ADR-0111,
 * `docs/design/agentic-project-intake.md`).
 *
 * This file is the CONTRACT the slices build against: the `project_intakes`
 * row's jsonb columns, the person routes under `/api/projects/[id]/intake`
 * and their typed client, Piloti's `POST /api/internal/project-intake`, the
 * Python tools (through `tests/fixtures/project-intake.schema.json`, generated
 * by `intake-schema.ts`), and the setup page. No `server-only`: the browser
 * imports it. Change it deliberately, in one commit with every caller.
 */

import { z } from 'zod'
import { geocodeResultSchema } from '@/lib/geocoding/types'
import type { ApplicableStatus } from '@/lib/oib/applicable-standards'
import {
  DERIVATION_RULES,
  derivationInputSchema,
  MAX_EVIDENCE_QUOTE_LENGTH,
  MAX_PROFILE_ALTERNATIVES,
  MAX_PROFILE_EVIDENCE,
  profileAlternativeSchema,
  profileEvidenceSchema,
} from '@/lib/project-profile/evidence-schema'
import type { ProjectIntakeQuestionType } from '@/lib/project-profile/intake-definition'
import { ProjectPrimitiveValueSchema } from '@/lib/project-profile/types'
import { isMonth, type Month } from '@/lib/projects/month'
import { PROJECT_OUTCOMES } from '@/lib/projects/project-status'

export {
  DERIVATION_RULES,
  MAX_DERIVATION_INPUTS,
  MAX_EVIDENCE_QUOTE_LENGTH,
  MAX_PROFILE_ALTERNATIVES,
  MAX_PROFILE_EVIDENCE,
  PROFILE_EVIDENCE_KINDS,
  derivationEvidenceSchema,
  derivationInputSchema,
  documentEvidenceSchema,
  geocoderEvidenceSchema,
  personEvidenceSchema,
  profileAlternativeSchema,
  profileEvidenceSchema,
} from '@/lib/project-profile/evidence-schema'
export type {
  DerivationEvidence,
  DerivationInput,
  DerivationRule,
  DocumentEvidence,
  ProfileAlternative,
  ProfileEvidence,
  ProfileEvidenceKind,
} from '@/lib/project-profile/evidence-schema'

// ---------------------------------------------------------------------------
// Vocabularies
// ---------------------------------------------------------------------------

/**
 * `waiting`: created, nothing read yet. `reading`: a run holds `job_id`.
 * `ready`: the last reading finished; the review is open. `failed`: the last
 * reading failed; a person may start another. `completed`: a person finished
 * the review (for a closing intent, the project was closed with it).
 */
export const INTAKE_STATUSES = ['waiting', 'reading', 'ready', 'failed', 'completed'] as const
export type IntakeStatus = (typeof INTAKE_STATUSES)[number]

/** `closing`: a past project, created active, read, then closed when the review is finished. */
export const INTAKE_MODES = ['active', 'closing'] as const
export type IntakeMode = (typeof INTAKE_MODES)[number]

/**
 * The wizard's question types that write a value onto the profile. `upload`,
 * `document_role` and `info_placeholder` write none, so they are never a need.
 */
export const INTAKE_NEED_TYPES = [
  'single_select',
  'multi_select',
  'boolean',
  'number',
  'text',
  'textarea',
  'number_tri',
  'yes_no_open',
] as const satisfies readonly ProjectIntakeQuestionType[]
export type IntakeNeedType = (typeof INTAKE_NEED_TYPES)[number]

/**
 * `open`: nothing on the profile. `suggested`: only a suggestion, which a
 * reading may corroborate or contradict. `confirmed`: a person confirmed it;
 * listed only for a Gebäudeklasse input, never decisive, so a reading of a
 * newer Stand can corroborate it or bring a contradiction a person decides.
 */
export const NEED_STATES = ['open', 'suggested', 'confirmed'] as const
export type NeedState = (typeof NEED_STATES)[number]

/** `contested`: a different value was found beside it (`alternatives` is not empty). */
export const SUGGESTION_STATES = ['suggested', 'confirmed', 'contested'] as const
export type SuggestionState = (typeof SUGGESTION_STATES)[number]

/** What a person does with one key on the review. */
export const INTAKE_DECISION_ACTIONS = ['confirm', 'dismiss', 'answer', 'unknown'] as const

/** What the BFF made of one recorded value. */
export const RECORD_OUTCOMES = ['suggested', 'corroborated', 'contradiction', 'refused'] as const

/**
 * Why a recorded value was refused: a token outside the question's options,
 * a key no wizard question writes (or a scope suffix that question is not
 * asked in, or a Bauwerk the profile does not describe), a value a person
 * dismissed, or evidence from a file outside the project's main collection
 * (`extractableFileNames`). A key whose question is not asked yet is not
 * refused: a reading may find a value before the answer that opens it.
 */
export const RECORD_REFUSAL_REASONS = ['vocabulary', 'unknown-key', 'dismissed', 'unreadable-file'] as const
export type RecordRefusalReason = (typeof RECORD_REFUSAL_REASONS)[number]

/**
 * What became of one withdrawal. `withdrawn`: the reading's own suggestion is
 * gone, with any alternative found beside it, and is not remembered as
 * dismissed (no person said no), so a later reading may suggest it again.
 */
export const WITHDRAW_OUTCOMES = ['withdrawn', 'refused'] as const

/**
 * Why a withdrawal was refused: nothing is suggested under the key, a person
 * confirmed it (a fact), or the suggestion is not this reading's own (an
 * earlier reading's, the derived Gebäudeklasse, a default). A reading takes
 * back only what it suggested itself.
 */
export const WITHDRAW_REFUSAL_REASONS = ['nothing-suggested', 'confirmed', 'not-this-reading'] as const
export type WithdrawRefusalReason = (typeof WITHDRAW_REFUSAL_REASONS)[number]

/** The 409 reason when an internal op names a `jobId` that is not the intake's current reading. */
export const STALE_READING_REASON = 'stale-reading'

export const MAX_INTAKE_DESCRIPTION_LENGTH = 500
export const MAX_INTAKE_SUMMARY_LENGTH = 2000
/** Most values one `record` carries, and most keys one `withdraw` names. */
export const MAX_RECORD_VALUES = 20
/** Most decisions one request carries. */
export const MAX_INTAKE_DECISIONS = 60
/** Most unread file names `needs` answers with. */
export const MAX_UNREAD_FILES = 200
/** Most file names one `finish` reports as read. */
export const MAX_DOCUMENTS_READ = 500
/** Most needs one answer lists: every question, per Bauwerk, with room. */
export const MAX_INTAKE_NEEDS = 500

const key = z.string().min(1).max(200)
const jobId = z.string().min(1).max(128)
const instant = z.string().datetime({ offset: true })
const count = z.number().int().min(0)
const alternativeIndex = z.number().int().min(0).max(MAX_PROFILE_ALTERNATIVES - 1)

/** `YYYY-MM`, as the create form's month inputs and `lib/projects/month.ts` write it. */
const monthSchema = z.string().refine((value): value is Month => isMonth(value), 'A month, YYYY-MM.')

// ---------------------------------------------------------------------------
// The row's jsonb columns
// ---------------------------------------------------------------------------

/**
 * A past project's end, carried from creation to the review's completion,
 * when the project is closed with it (`setProjectStatus`). The same fields as
 * the create route's `closing`.
 */
export const closingIntentSchema = z
  .object({
    outcome: z.enum(PROJECT_OUTCOMES),
    startedOn: monthSchema.nullish(),
    endedOn: monthSchema,
  })
  .strict()
export type ClosingIntent = z.infer<typeof closingIntentSchema>

/** One document a reading read, by its content: a new Fassung has a new hash and is read again. */
export const documentReadSchema = z.object({
  documentId: z.string().uuid(),
  contentHash: z.string().min(1).max(128),
})
export type DocumentRead = z.infer<typeof documentReadSchema>

/** A value a person dismissed for a key, so no reading suggests it again. */
export const dismissedValueSchema = z.object({
  key,
  value: ProjectPrimitiveValueSchema,
})
export type DismissedValue = z.infer<typeof dismissedValueSchema>

/** What the last finished reading left. */
export const intakeCountsSchema = z.object({
  documentsRead: count,
  suggested: count,
  contradictions: count,
  decisiveOpen: count,
})
export type IntakeCounts = z.infer<typeof intakeCountsSchema>

// ---------------------------------------------------------------------------
// Needs, suggestions, derivations
// ---------------------------------------------------------------------------

/** One option of a select question: the token the profile stores, and its label. */
export const needOptionSchema = z.object({
  token: z.string().min(1).max(200),
  label: z.string().min(1).max(300),
})
export type NeedOption = z.infer<typeof needOptionSchema>

/**
 * A key the project still needs (`computeNeeds` in `needs.ts`): a question
 * whose conditions hold and that writes a profile key, scoped per Bauwerk as
 * the wizard scopes it. `key` is the profile key (`geschosse_oberirdisch@bw1`),
 * `baseKey` the part before `@`, `bauwerkId` the `bwN` or null for a project
 * key. `decisive`: filling it could change the Gebäudeklasse (never for a
 * `confirmed` one).
 */
export const needSchema = z.object({
  key,
  baseKey: key,
  bauwerkId: z.string().min(1).max(32).nullable(),
  label: z.string().min(1).max(300),
  type: z.enum(INTAKE_NEED_TYPES),
  options: z.array(needOptionSchema).max(100).optional(),
  unit: z.string().max(20).optional(),
  why: z.string().max(1000).optional(),
  /** The documents a value is usually in (Einreichplan, Baubeschreibung …). */
  foundIn: z.array(z.string().min(1).max(100)).max(20),
  decisive: z.boolean(),
  state: z.enum(NEED_STATES),
})
export type Need = z.infer<typeof needSchema>

/** A value on the profile as the review shows it: suggested or confirmed, with where it was found. */
export const suggestionSchema = z.object({
  key,
  baseKey: key,
  bauwerkId: z.string().min(1).max(32).nullable(),
  label: z.string().min(1).max(300),
  value: ProjectPrimitiveValueSchema,
  /** The value as a person reads it (option labels, unit). */
  display: z.string().max(1000),
  state: z.enum(SUGGESTION_STATES),
  evidence: z.array(profileEvidenceSchema).max(MAX_PROFILE_EVIDENCE),
  alternatives: z.array(profileAlternativeSchema).max(MAX_PROFILE_ALTERNATIVES),
  decisive: z.boolean(),
})
export type Suggestion = z.infer<typeof suggestionSchema>

/**
 * A derivation for one Bauwerk. `value` is the class 1..5, or null while an
 * input is missing or when the building is a Hochhaus (Fluchtniveau above
 * 22 m, OIB-RL 2.3), which has no Gebäudeklasse. `inputs` are the values it
 * read; `missing` the base keys it still needs.
 */
export const derivationViewSchema = z.object({
  bauwerkId: z.string().min(1).max(32),
  rule: z.enum(DERIVATION_RULES),
  /** The Fundstelle, as the derivation's evidence names it. */
  citation: z.string().min(1).max(300),
  value: z.number().int().min(1).max(5).nullable(),
  hochhaus: z.boolean(),
  inputs: z.array(derivationInputSchema).max(20),
  missing: z.array(key).max(20),
})
export type DerivationView = z.infer<typeof derivationViewSchema>

/**
 * A derivation as the review shows it, with the class's own suggestion
 * (`gebaeudeklasse@bwN`): the one place a person confirms the class, because
 * the review's modules leave the derived class out.
 */
export const derivationReviewSchema = derivationViewSchema.extend({ suggestion: suggestionSchema.nullable() })
export type DerivationReview = z.infer<typeof derivationReviewSchema>

/** One module of the wizard on the review, by the definition's stage id. */
export const suggestionGroupSchema = z.object({
  stage: z.string().min(1).max(8),
  title: z.string().min(1).max(200),
  items: z.array(suggestionSchema),
})
export type SuggestionGroup = z.infer<typeof suggestionGroupSchema>

// ---------------------------------------------------------------------------
// Person routes (`lib/project-intake/client.ts`, ADR-0055)
// ---------------------------------------------------------------------------

/**
 * `GET /api/projects/[id]/intake` → {@link intakeResponseSchema}. The review:
 * `contradictions` first, then `questions` (decisive and open), then every
 * value by the wizard's modules, then the derivations.
 */
export const intakeViewSchema = z.object({
  projectId: z.string().uuid(),
  status: z.enum(INTAKE_STATUSES),
  mode: z.enum(INTAKE_MODES),
  description: z.string().max(MAX_INTAKE_DESCRIPTION_LENGTH).nullable(),
  location: geocodeResultSchema.nullable(),
  closing: closingIntentSchema.nullable(),
  counts: z.object({
    documentsRead: count,
    unreadDocuments: count,
    suggested: count,
    contradictions: count,
    decisiveOpen: count,
  }),
  readingStartedAt: instant.nullable(),
  readingFinishedAt: instant.nullable(),
  summary: z.string().max(MAX_INTAKE_SUMMARY_LENGTH).nullable(),
  contradictions: z.array(suggestionSchema),
  questions: z.array(needSchema).max(MAX_INTAKE_NEEDS),
  /**
   * Every other need no document has answered and no person has, in the
   * wizard's order: what the review asks one at a time after the decisive
   * questions. Without it a project with no documents yet had two questions
   * and no way to say anything else (the „interview" a pilot sync missed).
   */
  openQuestions: z.array(needSchema).max(MAX_INTAKE_NEEDS),
  groups: z.array(suggestionGroupSchema),
  derivations: z.array(derivationReviewSchema),
  /** The reader may decide (profile write: `project:memory:write` or `project:edit`) and start a reading. */
  canDecide: z.boolean(),
  /** The reader may finish the review: `project:manage` for a closing intent, else profile write. */
  canComplete: z.boolean(),
  // --- Step 5, Steckbrief (ticket 26) -------------------------------------
  /**
   * The rule set's Ampel: which OIB-Richtlinien apply, required / likely /
   * check, as `getApplicableStandards` (`lib/oib/applicable-standards.ts`)
   * computes it from the profile's confirmed values only, so a suggestion
   * changes it once a person takes it. The same verdicts the overview's panel
   * shows. `buildIntakeView` always sends it; optional so a view built
   * elsewhere (a fixture) may leave the panel out.
   */
  applicableStandards: z
    .array(
      z.object({
        code: z.string().min(1).max(32),
        titleEn: z.string().max(300),
        titleDe: z.string().max(300),
        scope: z.string().max(1000),
        oibUrl: z.string().max(500),
        status: z.enum(['required', 'likely', 'check'] as const satisfies readonly ApplicableStatus[]),
        reason: z.string().max(1000),
      })
    )
    .max(40)
    .optional(),
  // --- end Step 5 ----------------------------------------------------------
})
export type IntakeView = z.infer<typeof intakeViewSchema>

/** What every person route answers with: the intake as it stands after the call. */
export const intakeResponseSchema = z.object({ intake: intakeViewSchema })
export type IntakeResponse = z.infer<typeof intakeResponseSchema>

/** `POST /api/projects/[id]/intake`: start a reading now. `all` forgets what was read. */
export const startIntakeRequestSchema = z
  .object({ scope: z.enum(['new', 'all']) })
  .strict()
export type StartIntakeRequest = z.infer<typeof startIntakeRequestSchema>

/**
 * One decision. `confirm` writes the suggestion, or the alternative at
 * `alternativeIndex`, as a fact with its evidence. `dismiss` removes the
 * suggestion (or that alternative) and remembers the value. `answer` writes the
 * person's own value as a fact with `person` evidence. `unknown` records the
 * key as „nicht bekannt".
 */
export const intakeDecisionSchema = z.discriminatedUnion('action', [
  z.object({ key, action: z.literal('confirm'), alternativeIndex: alternativeIndex.optional() }).strict(),
  z.object({ key, action: z.literal('dismiss'), alternativeIndex: alternativeIndex.optional() }).strict(),
  z.object({ key, action: z.literal('answer'), value: ProjectPrimitiveValueSchema }).strict(),
  z.object({ key, action: z.literal('unknown') }).strict(),
])
export type IntakeDecision = z.infer<typeof intakeDecisionSchema>

/** `POST /api/projects/[id]/intake/decisions`. */
export const intakeDecisionsRequestSchema = z
  .object({ decisions: z.array(intakeDecisionSchema).min(1).max(MAX_INTAKE_DECISIONS) })
  .strict()

/** What one decision did, in request order. `reason` says why it did not go through. */
export const intakeDecisionResultSchema = z.object({
  key,
  ok: z.boolean(),
  reason: z.string().max(300).optional(),
})
export type IntakeDecisionResult = z.infer<typeof intakeDecisionResultSchema>

/** One result per decision, in request order, and the intake as it stands after them. */
export const intakeDecisionsResponseSchema = z.object({
  results: z.array(intakeDecisionResultSchema).max(MAX_INTAKE_DECISIONS),
  intake: intakeViewSchema,
})
export type IntakeDecisionsResponse = z.infer<typeof intakeDecisionsResponseSchema>

// ---------------------------------------------------------------------------
// Piloti's route: POST /api/internal/project-intake
// ---------------------------------------------------------------------------

/**
 * Where a recorded value was found. The project's documents only, by the name
 * the files list shows; the quote is what the tool read in this run, and the
 * BFF masks it before it is stored.
 */
export const recordEvidenceSchema = z
  .object({
    fileName: z.string().min(1).max(512),
    page: z.number().int().min(1).nullable(),
    quote: z.string().min(1).max(MAX_EVIDENCE_QUOTE_LENGTH),
  })
  .strict()

export const recordValueSchema = z
  .object({
    key,
    value: ProjectPrimitiveValueSchema,
    evidence: recordEvidenceSchema,
  })
  .strict()
export type RecordValue = z.infer<typeof recordValueSchema>

/**
 * Signed envelope (ADR-0054 §4, ADR-0108): the project is the envelope's, so
 * no body names one. Every op carries the reading's `jobId`; one that is not
 * the intake's current reading answers 409 {@link STALE_READING_REASON}.
 */
export const internalIntakeRequestSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('needs'), jobId }).strict(),
  z
    .object({
      op: z.literal('record'),
      jobId,
      values: z.array(recordValueSchema).min(1).max(MAX_RECORD_VALUES),
    })
    .strict(),
  z
    .object({
      op: z.literal('withdraw'),
      jobId,
      keys: z.array(key).min(1).max(MAX_RECORD_VALUES),
    })
    .strict(),
  z
    .object({
      op: z.literal('finish'),
      jobId,
      summary: z.string().max(MAX_INTAKE_SUMMARY_LENGTH),
      documentsRead: z.array(z.string().min(1).max(512)).max(MAX_DOCUMENTS_READ),
      traceId: z.string().min(1).max(128).nullable(),
    })
    .strict(),
])
export type InternalIntakeRequest = z.infer<typeof internalIntakeRequestSchema>
export type InternalIntakeOp = InternalIntakeRequest['op']

/** `needs`: what the project still needs, what has not been read yet, and what the last reading said. */
export const internalIntakeNeedsResponseSchema = z.object({
  needs: z.array(needSchema).max(MAX_INTAKE_NEEDS),
  unreadFiles: z.array(z.string()).max(MAX_UNREAD_FILES),
  description: z.string().max(MAX_INTAKE_DESCRIPTION_LENGTH).nullable(),
  location: geocodeResultSchema.nullable(),
  mode: z.enum(INTAKE_MODES),
  /**
   * The last finished reading's summary, as stored (masked): the agent's note
   * from its previous run, so a reading of new documents does not start blind.
   * Null before the first reading finished.
   */
  previousSummary: z.string().max(MAX_INTAKE_SUMMARY_LENGTH).nullable(),
})
export type InternalIntakeNeedsResponse = z.infer<typeof internalIntakeNeedsResponseSchema>

export const recordResultSchema = z.object({
  key,
  outcome: z.enum(RECORD_OUTCOMES),
  /** Set exactly when `outcome` is `refused`. */
  reason: z.enum(RECORD_REFUSAL_REASONS).optional(),
})
export type RecordResult = z.infer<typeof recordResultSchema>

/** A need the values of one `record` opened: not listed before it, open after it. */
export const openedNeedSchema = needSchema.pick({ key: true, decisive: true })
export type OpenedNeed = z.infer<typeof openedNeedSchema>

/**
 * `record`: one result per value, in request order, and the needs the values
 * opened (`bauwerkstyp = gebaeude` opens the Gebäude's questions), decisive
 * ones first, so the reading learns what its own record asked for next.
 */
export const internalIntakeRecordResponseSchema = z.object({
  results: z.array(recordResultSchema).max(MAX_RECORD_VALUES),
  opened: z.array(openedNeedSchema).max(MAX_INTAKE_NEEDS),
})
export type InternalIntakeRecordResponse = z.infer<typeof internalIntakeRecordResponseSchema>

export const withdrawResultSchema = z.object({
  key,
  outcome: z.enum(WITHDRAW_OUTCOMES),
  /** Set exactly when `outcome` is `refused`. */
  reason: z.enum(WITHDRAW_REFUSAL_REASONS).optional(),
})
export type WithdrawResult = z.infer<typeof withdrawResultSchema>

/** `withdraw`: one result per key, in request order. */
export const internalIntakeWithdrawResponseSchema = z.object({
  results: z.array(withdrawResultSchema).max(MAX_RECORD_VALUES),
})
export type InternalIntakeWithdrawResponse = z.infer<typeof internalIntakeWithdrawResponseSchema>

/** `finish`: the status the intake is in afterwards. */
export const internalIntakeFinishResponseSchema = z.object({
  status: z.enum(INTAKE_STATUSES),
})
export type InternalIntakeFinishResponse = z.infer<typeof internalIntakeFinishResponseSchema>

/** The answer schema for each op, so the route and the client parse by the op they sent. */
export const INTERNAL_INTAKE_RESPONSE_SCHEMAS = {
  needs: internalIntakeNeedsResponseSchema,
  record: internalIntakeRecordResponseSchema,
  withdraw: internalIntakeWithdrawResponseSchema,
  finish: internalIntakeFinishResponseSchema,
} as const satisfies Record<InternalIntakeOp, z.ZodTypeAny>

export type InternalIntakeResponse<Op extends InternalIntakeOp = InternalIntakeOp> = z.infer<
  (typeof INTERNAL_INTAKE_RESPONSE_SCHEMAS)[Op]
>
