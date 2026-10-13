/**
 * The Anmerkungen wire schemas Piloti's tool speaks, as JSON Schema, for the
 * Python tier (ADR-0055). Generated from `types.ts` into
 * `tests/fixtures/document-annotations.schema.json`, which the agent's tool is
 * tested against (`tests/aiq_agent/tools/annotations/test_wire_contract.py`),
 * so the two languages read one contract.
 */

import { jsonSchemaDocument, type JsonSchemaNode } from '@/lib/api/zod-json-schema'
import { ANNOTATION_WIRE_SCHEMAS } from './types'

/** The whole export, exactly as the fixture holds it; `$defs` keyed by the names in `ANNOTATION_WIRE_SCHEMAS`. */
export function documentAnnotationsJsonSchema(): JsonSchemaNode {
  return jsonSchemaDocument(ANNOTATION_WIRE_SCHEMAS, {
    title: 'Grid document annotations wire contract',
    description:
      'Generated from frontends/ui/src/lib/annotations/types.ts. Do not edit by hand: ' +
      'annotation-schema.spec.ts rewrites this file and fails when it is stale.',
  })
}
