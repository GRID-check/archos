/**
 * The project intake's wire schemas, as JSON Schema, for the Python tier
 * (ADR-0055, ADR-0111). Generated from `types.ts` into
 * `tests/fixtures/project-intake.schema.json`, which the Erfassungs-Agent's
 * tools are tested against, so the two languages read one contract.
 */

import { jsonSchemaDocument, type JsonSchemaNode } from '@/lib/api/zod-json-schema'
import {
  internalIntakeFinishResponseSchema,
  internalIntakeNeedsResponseSchema,
  internalIntakeRecordResponseSchema,
  internalIntakeRequestSchema,
  internalIntakeWithdrawResponseSchema,
  intakeViewSchema,
  needSchema,
  profileEvidenceSchema,
} from './types'

/** Every shape the fixture carries, by the name the Python side looks it up by. */
export const INTAKE_WIRE_SCHEMAS = {
  InternalIntakeRequest: internalIntakeRequestSchema,
  InternalIntakeNeedsResponse: internalIntakeNeedsResponseSchema,
  InternalIntakeRecordResponse: internalIntakeRecordResponseSchema,
  InternalIntakeWithdrawResponse: internalIntakeWithdrawResponseSchema,
  InternalIntakeFinishResponse: internalIntakeFinishResponseSchema,
  Need: needSchema,
  ProfileEvidence: profileEvidenceSchema,
  IntakeView: intakeViewSchema,
} as const

/** The whole export, exactly as the fixture holds it; `$defs` keyed by the names in {@link INTAKE_WIRE_SCHEMAS}. */
export function projectIntakeJsonSchema(): JsonSchemaNode {
  return jsonSchemaDocument(INTAKE_WIRE_SCHEMAS, {
    title: 'Grid project intake wire contract',
    description:
      'Generated from frontends/ui/src/lib/project-intake/types.ts. Do not edit by hand: ' +
      'intake-schema.spec.ts rewrites this file and fails when it is stale.',
  })
}
