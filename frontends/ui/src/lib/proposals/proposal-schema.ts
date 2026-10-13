/**
 * The proposed-change wire schemas Piloti's file tool speaks, as JSON Schema,
 * for the Python tier (ADR-0055). Generated from `types.ts` into
 * `tests/fixtures/proposals.schema.json`, which the agent's tool is tested
 * against, so the two languages read one contract.
 */

import { jsonSchemaDocument, type JsonSchemaNode } from '@/lib/api/zod-json-schema'
import {
  fileOperationPayloadSchema,
  internalProposalRequestSchema,
  internalProposalResponseSchema,
  proposalResponseSchema,
  proposedChangeViewSchema,
} from './types'

/** Every shape the fixture carries, by the name the Python side looks it up by. */
export const PROPOSAL_WIRE_SCHEMAS = {
  InternalProposalRequest: internalProposalRequestSchema,
  InternalProposalResponse: internalProposalResponseSchema,
  FileOperationPayload: fileOperationPayloadSchema,
  ProposedChangeView: proposedChangeViewSchema,
  ProposalResponse: proposalResponseSchema,
} as const

/** The whole export, exactly as the fixture holds it; `$defs` keyed by the names in {@link PROPOSAL_WIRE_SCHEMAS}. */
export function proposalsJsonSchema(): JsonSchemaNode {
  return jsonSchemaDocument(PROPOSAL_WIRE_SCHEMAS, {
    title: 'Grid proposed changes wire contract',
    description:
      'Generated from frontends/ui/src/lib/proposals/types.ts. Do not edit by hand: ' +
      'proposal-schema.spec.ts rewrites this file and fails when it is stale.',
  })
}
