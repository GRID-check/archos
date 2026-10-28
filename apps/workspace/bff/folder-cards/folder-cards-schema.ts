/**
 * The folder card wire schemas as JSON Schema for the Python tier (ADR-0055),
 * generated from `types.ts` into `tests/fixtures/folder-cards.schema.json`.
 */

import { jsonSchemaDocument, type JsonSchemaNode } from '@/lib/api/zod-json-schema'
import { FOLDER_CARD_WIRE_SCHEMAS } from './types'

export function folderCardsJsonSchema(): JsonSchemaNode {
  return jsonSchemaDocument(FOLDER_CARD_WIRE_SCHEMAS, {
    title: 'Grid folder card wire contract',
    description:
      'Generated from apps/workspace/bff/folder-cards/types.ts. Do not edit by hand: ' +
      'folder-cards-schema.spec.ts rewrites this file and fails when it is stale.',
  })
}
