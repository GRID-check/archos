/**
 * Budgets API client
 *
 * Typed fetch client for the organization's budget policies
 * (`/api/organization/budgets`): setting and removing one member's or one
 * project's limit. Same-origin BFF route; the request shapes are the route's own
 * zod schemas in `lib/organizations/organization-wire.ts`, so the body types here
 * cannot drift from what the server parses.
 *
 * The client transports the request and surfaces a non-OK answer as
 * {@link ApiRequestError} carrying the HTTP status. The caller decides what a
 * status means: the limit editor shows a 422 as a rejected limit and everything
 * else as a failed save.
 */

import type { z } from 'zod'
import type { budgetDeleteSchema, budgetPutSchema } from '@/lib/organizations/organization-wire'
import { ApiRequestError } from './api-error'

// ============================================================
// Types
// ============================================================

/** Set-a-limit payload (`PUT`): limits are decimal numbers, `null` means no limit. */
export type BudgetPolicyInput = z.input<typeof budgetPutSchema>

/** Remove-a-limit payload (`DELETE`). */
export type BudgetPolicyRemoval = z.input<typeof budgetDeleteSchema>

const BUDGETS_PATH = '/api/organization/budgets'

const jsonHeaders: HeadersInit = { 'Content-Type': 'application/json' }

const failure = (context: string, status: number): ApiRequestError =>
  new ApiRequestError(`${context}: ${status}`, status)

// ============================================================
// Budgets API
// ============================================================

/** Set one subject's daily and monthly limit. A rejected limit answers 422. */
export const setBudgetPolicy = async (input: BudgetPolicyInput): Promise<void> => {
  const response = await fetch(BUDGETS_PATH, {
    method: 'PUT',
    headers: jsonHeaders,
    body: JSON.stringify(input),
  })
  if (!response.ok) throw failure('Failed to save budget policy', response.status)
}

/** Remove one subject's limit. */
export const removeBudgetPolicy = async (input: BudgetPolicyRemoval): Promise<void> => {
  const response = await fetch(BUDGETS_PATH, {
    method: 'DELETE',
    headers: jsonHeaders,
    body: JSON.stringify(input),
  })
  if (!response.ok) throw failure('Failed to remove budget policy', response.status)
}
