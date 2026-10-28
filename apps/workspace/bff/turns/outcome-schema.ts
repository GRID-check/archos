/**
 * The turn-outcome wire schemas as JSON Schema, for the chat socket (ADR-0055).
 * Generated from `outcome-types.ts` into `tests/fixtures/turn-outcome.schema.json`.
 */

import { jsonSchemaDocument, type JsonSchemaNode } from '@/lib/api/zod-json-schema'
import { turnOutcomeRequestSchema, turnOutcomeResponseSchema } from './outcome-types'

export const TURN_OUTCOME_WIRE_SCHEMAS = {
  TurnOutcomeRequest: turnOutcomeRequestSchema,
  TurnOutcomeResponse: turnOutcomeResponseSchema,
} as const

export function turnOutcomeJsonSchema(): JsonSchemaNode {
  return jsonSchemaDocument(TURN_OUTCOME_WIRE_SCHEMAS, {
    title: 'Grid turn outcome wire contract',
    description:
      'Generated from apps/workspace/bff/turns/outcome-types.ts. Do not edit by hand: ' +
      'outcome-schema.spec.ts rewrites this file and fails when it is stale.',
  })
}
