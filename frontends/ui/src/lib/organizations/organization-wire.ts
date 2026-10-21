/**
 * The bodies and queries of the `/api/organization/*` routes, kept out of the
 * route files (a Next route exports handlers only) so each route and the MCP
 * catalog (`lib/agent-api/catalog/organization.ts`) parse against one schema.
 */

import { z } from 'zod'
import { locales } from '@/i18n/config'
import { DELETED_FOLDER_CONTENT_POLICIES } from '@/lib/authz/folder-access-rule'
import {
  PROJECT_MEMORY_CONFIDENCES,
  PROJECT_MEMORY_KINDS,
  PROJECT_MEMORY_STATUSES,
  PROJECT_MEMORY_VERIFICATIONS,
} from '@/lib/projects/memory-vocabulary'
import { ACCESS_LOG_MAX_LIMIT, DOWNLOAD_LOG_KINDS } from '@/lib/download-log/kinds'
import { AGENT_GROUP_IDS, MODEL_ID_PATTERN } from '@/lib/model-config/agent-groups'
import { ORG_INSTRUCTIONS_MAX_CHARS } from '@/lib/org-instructions/constants'
import { CHAT_EFFORT_SETTING, CHAT_EFFORTS, isChatEffort } from '@/lib/reasoning-settings/catalog'

// --- budgets ---------------------------------------------------------------

const limitSchema = z.number().min(0).finite().nullable()

export const budgetPutSchema = z.object({
  scope: z.enum(['organization', 'member', 'project']),
  subjectId: z.string().min(1).max(120).nullable().optional(),
  dailyLimit: limitSchema,
  monthlyLimit: limitSchema,
  note: z.string().trim().max(500).nullable().optional(),
})

export const budgetDeleteSchema = z.object({
  scope: z.enum(['member', 'project']),
  subjectId: z.string().min(1).max(120),
})

export const usageQuerySchema = z.object({
  userId: z.string().optional(),
  projectId: z.string().optional(),
})

// --- deleted folder content ------------------------------------------------

export const deletedFolderContentSchema = z.object({
  policy: z.enum(DELETED_FOLDER_CONTENT_POLICIES),
})

// --- download log ----------------------------------------------------------

const day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .transform((value) => new Date(`${value}T00:00:00.000Z`))
  .refine((date) => !Number.isNaN(date.getTime()))

export const downloadLogQuerySchema = z.object({
  userId: z.string().min(1).max(128).optional(),
  document: z.string().trim().min(1).max(200).optional(),
  kind: z.enum(DOWNLOAD_LOG_KINDS).optional(),
  /** First day shown (UTC), inclusive. */
  from: day.optional(),
  /** Last day shown (UTC), inclusive: the query is below the start of the day after. */
  to: day.optional(),
  cursor: z.string().min(1).max(500).optional(),
  limit: z.coerce.number().int().min(1).max(ACCESS_LOG_MAX_LIMIT).optional(),
})

export const downloadLogRetentionSchema = z.object({ days: z.number().int() })

// --- instructions ----------------------------------------------------------

export const orgInstructionsSchema = z.object({
  instructions: z
    .string()
    .max(
      ORG_INSTRUCTIONS_MAX_CHARS,
      `Instructions are at most ${ORG_INSTRUCTIONS_MAX_CHARS} characters.`,
    ),
})

// --- memory ----------------------------------------------------------------

export const createOrgMemorySchema = z.object({
  kind: z.enum(PROJECT_MEMORY_KINDS),
  content: z.string().trim().min(1).max(2000),
  confidence: z.enum(PROJECT_MEMORY_CONFIDENCES).optional(),
  pinned: z.boolean().optional(),
})

export const patchOrgMemorySchema = z
  .object({
    kind: z.enum(PROJECT_MEMORY_KINDS).optional(),
    content: z.string().trim().min(1).max(2000).optional(),
    status: z.enum(PROJECT_MEMORY_STATUSES).optional(),
    confidence: z.enum(PROJECT_MEMORY_CONFIDENCES).optional(),
    verification: z.enum(PROJECT_MEMORY_VERIFICATIONS).optional(),
    pinned: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: 'Empty patch' })

// --- model configuration ---------------------------------------------------

export const modelSearchQuerySchema = z.object({
  group: z.string().default(''),
  q: z.string().default(''),
})

export const modelConfigPutSchema = z.object({
  overrides: z.record(
    z.enum(AGENT_GROUP_IDS as [string, ...string[]]),
    // BYOK-aware shape (`author/slug` OR provider-native id, ADR-0022);
    // catalog membership is the real gate.
    z.object({ model: z.string().regex(MODEL_ID_PATTERN, 'not a plausible model id') }),
  ),
  comment: z.string().trim().max(500).nullable().optional(),
})

export const zdrPutSchema = z.object({ enabled: z.boolean() })

// --- settings --------------------------------------------------------------

export const orgSettingsPutSchema = z.object({
  displayName: z.string().trim().max(200).nullable().optional(),
  defaultLocale: z.enum(locales).nullable().optional(),
  settings: z
    .record(z.unknown())
    .refine((bag) => !(CHAT_EFFORT_SETTING in bag) || isChatEffort(bag[CHAT_EFFORT_SETTING]), {
      message: `${CHAT_EFFORT_SETTING} must be one of: ${CHAT_EFFORTS.join(', ')}`,
      path: [CHAT_EFFORT_SETTING],
    })
    .optional(),
})

/** `GET /api/organization/usage/notice`: the chat's usage notice, optionally for one project. */
export const usageNoticeQuerySchema = z.object({
  projectId: z.string().max(120).optional(),
})
