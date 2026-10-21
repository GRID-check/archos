/**
 * The input of a proposed operation, flattened into rows a person can scan on
 * the card (`OperationReceipt`): one row per path parameter, query parameter
 * and top-level body field, in that order of importance reversed so what the
 * action changes (the body) comes first. A scalar is shown as it is; anything
 * nested is shown as compact JSON. Every value is clipped, the list is bounded.
 */

export interface OperationInputRow {
  key: string
  value: string
}

/** Longest value shown in a row. */
const VALUE_LENGTH = 120
/** Most rows shown; the rest is counted by the caller. */
export const MAX_INPUT_ROWS = 8

function show(value: unknown): string {
  const text = typeof value === 'string' ? value : (JSON.stringify(value) ?? String(value))
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > VALUE_LENGTH ? `${flat.slice(0, VALUE_LENGTH - 1)}…` : flat
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function rowsOf(record: unknown): OperationInputRow[] {
  if (!isRecord(record)) return []
  return Object.entries(record)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => ({ key, value: show(value) }))
}

/** All the rows of `input`, body first, then query, then path parameters. */
export function operationInputRows(input: Record<string, unknown>): OperationInputRow[] {
  const body = input.body
  const bodyRows = isRecord(body)
    ? rowsOf(body)
    : body === undefined || body === null
      ? []
      : [{ key: 'body', value: show(body) }]
  return [...bodyRows, ...rowsOf(input.query), ...rowsOf(input.params)]
}
