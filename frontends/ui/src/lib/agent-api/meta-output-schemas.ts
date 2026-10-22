/**
 * The result shapes of three meta-tools, as `outputSchema` in `tools/list`
 * (MCP: a client validates `structuredContent` against it). Declared only where
 * every non-error result has that shape; `call-operation` answers whatever the
 * operation answers, so it declares none.
 *
 * The SDK turns a non-error result WITHOUT `structuredContent` into an error,
 * and `success()` (discovery.ts) leaves it out when the text was cut at
 * MAX_RESULT_CHARS. `meta-output-schemas.spec.ts` holds that these three cannot
 * reach the cap: at most 50 search hits, and the largest description.
 *
 * Not part of `metaToolsFor`: Piloti's own client fixture
 * (`tools/workspace/meta_tools.json`) stays as it is.
 */

export const SEARCH_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    total: { type: 'integer', description: 'How many operations matched; operations holds the best of them.' },
    operations: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          summary: { type: 'string' },
          domain: { type: 'string' },
          readOnly: { type: 'boolean' },
          destructive: { type: 'boolean' },
        },
        required: ['name', 'summary', 'domain', 'readOnly', 'destructive'],
      },
    },
    next: { type: 'string', description: 'What to do next.' },
  },
  required: ['total', 'operations', 'next'],
} as const

export const DESCRIBE_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    domain: { type: 'string' },
    summary: { type: 'string' },
    description: { type: 'string' },
    annotations: { type: 'object', description: 'The MCP tool annotations: readOnlyHint, destructiveHint, idempotentHint, openWorldHint.' },
    sensitivity: { type: ['string', 'null'], description: 'Why a call needs the person’s confirmation, or null.' },
    inputSchema: { type: 'object', description: 'JSON Schema of the `input` call-operation takes.' },
  },
  required: ['name', 'domain', 'summary', 'description', 'annotations', 'sensitivity', 'inputSchema'],
} as const

export const REPORT_OUTPUT_SCHEMA = {
  type: 'object',
  properties: { status: { type: 'string', enum: ['recorded'] } },
  required: ['status'],
} as const

export const META_OUTPUT_SCHEMAS = {
  'search-operations': SEARCH_OUTPUT_SCHEMA,
  'describe-operation': DESCRIBE_OUTPUT_SCHEMA,
  'report-missing-operation': REPORT_OUTPUT_SCHEMA,
} as const
