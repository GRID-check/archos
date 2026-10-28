/**
 * The wire contract of `POST /api/internal/runs/[runId]/envelope`: the job
 * worker asks the BFF for a FRESH signed request-context envelope for a run it
 * is about to execute, or is executing, so the run's tools act as the person
 * who commissioned it (ADR-0108).
 *
 * The worker never signs (`packages/agent/src/aiq_agent/tools/AGENTS.md`, "echo, never sign").
 * It carries the envelope the BFF minted at submit and, once that is older than
 * the renewal age, asks this route for a new one. The BFF re-derives everything
 * from the `task_runs` row and the requester's CURRENT membership: a requester
 * who left the organization, lost the permission, or whose run is no longer
 * active gets a refusal, never a borrowed grant.
 *
 * Exported as `tests/fixtures/run-envelope.schema.json` (`run-envelope-schema.spec.ts`),
 * which the Python worker's client is tested against.
 */

import { z } from 'zod'

/** The request carries nothing: the run id is the path, identity is the row's. */
export const runEnvelopeRequestSchema = z.object({}).strict()
export type RunEnvelopeRequest = z.infer<typeof runEnvelopeRequestSchema>

/** A signed envelope, exactly the two header values a chat turn carries. */
export const runEnvelopeResponseSchema = z
  .object({
    /** `x-grid-request-context`: the base64url payload. */
    header: z.string().min(1),
    /** `x-grid-request-context-sig`: its HMAC. */
    signature: z.string().min(1),
    /** The payload's `issuedAt`, epoch milliseconds, so the worker knows when to renew again. */
    issuedAt: z.number().int().positive(),
  })
  .strict()
export type RunEnvelopeResponse = z.infer<typeof runEnvelopeResponseSchema>

/**
 * Why the BFF will not renew. 404 `unknown-run`; 409 `run-not-active`;
 * 403 `requester-may-not-act` (left the organization, lost the right, or the
 * organization's switch is off). The worker then runs on WITHOUT an envelope,
 * as every run did before ADR-0108: tools that act as a person refuse.
 */
export const RUN_ENVELOPE_REFUSALS = ['unknown-run', 'run-not-active', 'requester-may-not-act'] as const
export type RunEnvelopeRefusal = (typeof RUN_ENVELOPE_REFUSALS)[number]

export const runEnvelopeErrorSchema = z
  .object({ error: z.enum(RUN_ENVELOPE_REFUSALS), message: z.string() })
  .strict()
export type RunEnvelopeError = z.infer<typeof runEnvelopeErrorSchema>

/** Renew once the carried envelope is this old; the envelope itself lives 6 h (`REQUEST_CONTEXT_MAX_AGE_MS`). */
export const RUN_ENVELOPE_RENEW_AFTER_MS = 60 * 60 * 1000
