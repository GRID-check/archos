/**
 * Turn-event keys (and their value names) that stored messages carry from before
 * the English names.
 *
 * A locator round's key was `status.retrieval.punkt` with a `punkt` value; a
 * thread stored by an older build keeps both. The migration rewrote the table
 * once; this keeps rows in flight (a pod not yet rolled, browser storage)
 * readable. Read-only: nothing writes these.
 */

export const LEGACY_TURN_EVENT_KEYS: Readonly<Record<string, string>> = {
  'status.retrieval.punkt': 'status.retrieval.clause',
}

/** The value names that were renamed with their key. */
export const LEGACY_TURN_EVENT_VALUE_NAMES: Readonly<Record<string, string>> = {
  punkt: 'clause',
}

export const modernizeTurnEventKey = (key: string): string => LEGACY_TURN_EVENT_KEYS[key] ?? key

/** The value name for a key, English whichever spelling it was stored in. */
export const modernizeTurnEventValueName = (key: string, name: string): string =>
  key === 'status.retrieval.clause' || key === 'status.retrieval.punkt'
    ? (LEGACY_TURN_EVENT_VALUE_NAMES[name] ?? name)
    : name
