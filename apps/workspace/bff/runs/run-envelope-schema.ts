/**
 * The run-envelope wire schemas as JSON Schema, for the Python worker
 * (ADR-0055). Generated from `run-envelope-types.ts` into
 * `tests/fixtures/run-envelope.schema.json`.
 */

import { jsonSchemaDocument, type JsonSchemaNode } from '@/lib/api/zod-json-schema'
import { runEnvelopeErrorSchema, runEnvelopeRequestSchema, runEnvelopeResponseSchema } from './run-envelope-types'

export const RUN_ENVELOPE_WIRE_SCHEMAS = {
  RunEnvelopeRequest: runEnvelopeRequestSchema,
  RunEnvelopeResponse: runEnvelopeResponseSchema,
  RunEnvelopeError: runEnvelopeErrorSchema,
} as const

export function runEnvelopeJsonSchema(): JsonSchemaNode {
  return jsonSchemaDocument(RUN_ENVELOPE_WIRE_SCHEMAS, {
    title: 'Grid run envelope wire contract',
    description:
      'Generated from apps/workspace/bff/runs/run-envelope-types.ts. Do not edit by hand: ' +
      'run-envelope-schema.spec.ts rewrites this file and fails when it is stale.',
  })
}
