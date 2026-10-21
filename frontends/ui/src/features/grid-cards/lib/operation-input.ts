/**
 * The input of a proposed operation, flattened into rows a person can read on
 * the card (`OperationReceipt`): one row per path parameter, query parameter
 * and top-level body field, in that order of importance reversed so what the
 * action changes (the body) comes first.
 *
 * Nothing is left out and nothing is cut for good. Every row carries its whole
 * value: a scalar as it is, anything nested as indented JSON. A value longer
 * than {@link PREVIEW_LENGTH}, or one spread over several lines, is `long`: the
 * card shows its {@link previewOf} until the reader unfolds it, and „Apply“
 * waits until every long row has been unfolded, so a person never accepts text
 * they were not shown (an injected instruction at the end of a long body).
 */

export interface OperationInputRow {
  key: string
  /** The whole value, as the card shows it unfolded. */
  value: string
  /** Shown in part until the reader unfolds it; the card refuses „Apply“ until then. */
  long: boolean
}

/** Longest value shown whole without unfolding. */
export const PREVIEW_LENGTH = 160

function show(value: unknown): string {
  if (typeof value === 'string') return value
  return JSON.stringify(value, null, 2) ?? String(value)
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function rowOf(key: string, value: unknown): OperationInputRow {
  const text = show(value)
  return { key, value: text, long: text.length > PREVIEW_LENGTH || text.includes('\n') }
}

function rowsOf(record: unknown): OperationInputRow[] {
  if (!isRecord(record)) return []
  return Object.entries(record)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => rowOf(key, value))
}

/** Every row of `input`, body first, then query, then path parameters. */
export function operationInputRows(input: Record<string, unknown>): OperationInputRow[] {
  const body = input.body
  const bodyRows = isRecord(body) ? rowsOf(body) : body === undefined || body === null ? [] : [rowOf('body', body)]
  return [...bodyRows, ...rowsOf(input.query), ...rowsOf(input.params)]
}

/** The start of a long value, on one line, marked as cut. */
export function previewOf(row: OperationInputRow): string {
  const flat = row.value.replace(/\s+/g, ' ').trim()
  return flat.length > PREVIEW_LENGTH ? `${flat.slice(0, PREVIEW_LENGTH - 1)}…` : `${flat}…`
}

/** A stable key per row: the same field name may occur in body, query and params. */
export const rowKey = (row: OperationInputRow, index: number) => `${index}:${row.key}`
