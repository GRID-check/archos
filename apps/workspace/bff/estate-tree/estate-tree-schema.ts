/**
 * The estate tree's wire schemas as JSON Schema for the Python tier (ADR-0055),
 * generated from `types.ts` into `tests/fixtures/estate-tree.schema.json`.
 */

import { jsonSchemaDocument, type JsonSchemaNode } from '@/lib/api/zod-json-schema'
import { ESTATE_TREE_WIRE_SCHEMAS } from './types'

export function estateTreeJsonSchema(): JsonSchemaNode {
  return jsonSchemaDocument(ESTATE_TREE_WIRE_SCHEMAS, {
    title: 'Grid estate tree wire contract',
    description:
      'Generated from frontends/ui/src/lib/estate-tree/types.ts. Do not edit by hand: ' +
      'estate-tree-schema.spec.ts rewrites this file and fails when it is stale.',
  })
}
