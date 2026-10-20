/**
 * The German names the project profile used to store, and what they are called
 * now. ONE normalizer for the whole vocabulary: a stored key (`bundesland`), a
 * select token (`wien`), the building instance id (`bw1`) and the derivation
 * rule (`gebaeudeklasse`).
 *
 * Why it exists. Migrations 0159-0162 rewrote every row, but data written before
 * the deploy can still arrive for one release: a row an older pod wrote while
 * the rolling deploy ran, a pending proposal's patch, a card in a stored
 * message, a value the intake agent (an older image) records, a persisted job
 * envelope. Every such path calls this module on the way IN; nothing writes an
 * old name again. When the last of those has drained, delete the module, its
 * JSON, its spec and the Python twin (`aiq_agent/profile_names.py`).
 *
 * The data is `legacy-names.json`, shared with the migrations and the Python
 * twin through `legacy-names.spec.ts` and `tests/aiq_agent/common/test_profile_names.py`,
 * so the three cannot drift.
 */
import names from './legacy-names.json'

/** Old base key → new base key (`bundesland` → `federal_state`). */
export const LEGACY_PROFILE_KEYS: Readonly<Record<string, string>> = names.keys

/** NEW base key → { old token → new token }, for the select questions whose tokens were German. */
export const LEGACY_PROFILE_TOKENS: Readonly<Record<string, Readonly<Record<string, string>>>> = names.tokens

/** The derivation rule names inside `evidence`. */
export const LEGACY_DERIVATION_RULES: Readonly<Record<string, string>> = names.rules

/** The building instance id: `bw1` was the first building, `bldg1` is. */
export const LEGACY_BUILDING_PREFIX = names.building.legacyPrefix
export const BUILDING_PREFIX = names.building.prefix

const LEGACY_BUILDING_ID = new RegExp(`^${LEGACY_BUILDING_PREFIX}(\\d+)$`)

/** `bw2` → `bldg2`; anything else (`bldg2`, `null`) is returned as it came. */
export function normalizeBuildingId(id: string): string {
  const match = LEGACY_BUILDING_ID.exec(id)
  return match ? `${BUILDING_PREFIX}${match[1]}` : id
}

/** `bldg2` → `bw2`: the spelling a row an older pod wrote still has; anything else is returned as it came. */
export function legacyBuildingId(id: string): string {
  return id.startsWith(BUILDING_PREFIX) && /^\d+$/.test(id.slice(BUILDING_PREFIX.length))
    ? `${LEGACY_BUILDING_PREFIX}${id.slice(BUILDING_PREFIX.length)}`
    : id
}

/** `gebaeudeklasse` → `building_class`; a rule that is not legacy is returned as it came. */
export function normalizeDerivationRule(rule: string): string {
  return LEGACY_DERIVATION_RULES[rule] ?? rule
}

/** A base key (no `@`): the new name, or the key itself when it is not a legacy one. */
export function normalizeProfileBaseKey(base: string): string {
  return Object.hasOwn(LEGACY_PROFILE_KEYS, base) ? LEGACY_PROFILE_KEYS[base] : base
}

/**
 * A scoped zone suffix is a use token (`wohnen` → `residential`); the building
 * segment is `bwN`: `geschosse_oberirdisch@bw1@wohnen` →
 * `storeys_above_ground@bldg1@residential`.
 */
export function normalizeProfileKey(key: string): string {
  const [base, ...scopes] = key.split('@')
  const next = normalizeProfileBaseKey(base)
  if (scopes.length === 0) return next
  const [building, ...rest] = scopes
  const mapped = [normalizeBuildingId(building), ...rest.map((zone) => normalizeProfileToken('uses', zone))]
  return [next, ...mapped].join('@')
}

/** One select token of a (new or old) base key; a token that is not legacy is returned as it came. */
export function normalizeProfileToken(baseKey: string, token: string): string {
  const table = LEGACY_PROFILE_TOKENS[normalizeProfileBaseKey(baseKey)]
  return table && Object.hasOwn(table, token) ? table[token] : token
}

/** A stored value of `key` (scoped or not): a token, or the tokens of a multi-select. Other values pass through. */
export function normalizeProfileValue<T>(key: string, value: T): T {
  const base = normalizeProfileBaseKey(key.split('@')[0])
  if (!LEGACY_PROFILE_TOKENS[base]) return value
  if (typeof value === 'string') return normalizeProfileToken(base, value) as T
  if (Array.isArray(value)) return value.map((item) => (typeof item === 'string' ? normalizeProfileToken(base, item) : item)) as T
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A fact, an assumption: the value, and the derivation evidence's keys and rule. */
function normalizeEntry(key: string, entry: unknown): unknown {
  if (!isRecord(entry)) return entry
  const next: Record<string, unknown> = { ...entry }
  if ('value' in next) next.value = normalizeProfileValue(key, next.value)
  if (Array.isArray(next.alternatives)) {
    next.alternatives = next.alternatives.map((alternative) =>
      isRecord(alternative) ? normalizeAlternative(key, alternative) : alternative
    )
  }
  if (Array.isArray(next.evidence)) next.evidence = next.evidence.map(normalizeEvidence)
  return next
}

function normalizeAlternative(key: string, alternative: Record<string, unknown>): Record<string, unknown> {
  const next = { ...alternative }
  if ('value' in next) next.value = normalizeProfileValue(key, next.value)
  if (Array.isArray(next.evidence)) next.evidence = next.evidence.map(normalizeEvidence)
  return next
}

/** A derivation's evidence names its rule and the keys it read. */
export function normalizeEvidence(evidence: unknown): unknown {
  if (!isRecord(evidence) || evidence.kind !== 'derivation') return evidence
  const next: Record<string, unknown> = { ...evidence }
  if (typeof next.rule === 'string') next.rule = normalizeDerivationRule(next.rule)
  if (Array.isArray(next.inputs)) {
    next.inputs = next.inputs.map((input) => {
      if (!isRecord(input) || typeof input.key !== 'string') return input
      return { ...input, key: normalizeProfileKey(input.key), value: normalizeProfileValue(input.key, input.value) }
    })
  }
  return next
}

function normalizeRecord(
  section: unknown,
  mapEntry: (key: string, entry: unknown) => unknown
): unknown {
  if (!isRecord(section)) return section
  const out: Record<string, unknown> = {}
  for (const [oldKey, entry] of Object.entries(section)) {
    const key = normalizeProfileKey(oldKey)
    // A new-name entry wins over an old-name one: whatever a new pod wrote is newer.
    if (key !== oldKey && Object.hasOwn(section, key)) continue
    out[key] = mapEntry(key, entry)
  }
  return out
}

/**
 * A stored profile with every legacy key, token and building id renamed. Takes
 * the raw JSON (before the zod parse), returns a new object, and returns the
 * argument itself when it is not an object. Idempotent.
 */
export function normalizeLegacyProfile(raw: unknown): unknown {
  if (!isRecord(raw)) return raw
  const next: Record<string, unknown> = { ...raw }
  if ('facts' in next) next.facts = normalizeRecord(next.facts, normalizeEntry)
  if ('assumptions' in next) next.assumptions = normalizeRecord(next.assumptions, normalizeEntry)
  if ('goals' in next) next.goals = normalizeRecord(next.goals, (key, value) => normalizeProfileValue(key, value))
  if (Array.isArray(next.unknowns)) {
    next.unknowns = next.unknowns.map((item) => (typeof item === 'string' ? normalizeProfileKey(item) : item))
  }
  return next
}

/** A JSON-pointer segment holds `~0` and `~1` for `~` and `/`. */
function decodeSegment(segment: string): string {
  return segment.replaceAll('~1', '/').replaceAll('~0', '~')
}
function encodeSegment(segment: string): string {
  return segment.replaceAll('~', '~0').replaceAll('/', '~1')
}

/**
 * `/facts/bundesland/value` → `/facts/federal_state/value`. A path outside
 * `/facts`, `/assumptions`, `/goals` or `/unknowns/<key>` is returned as it came.
 */
export function normalizeProfilePatchPath(path: string): string {
  const parts = path.split('/')
  const section = parts[1]
  const keyed = section === 'facts' || section === 'assumptions' || section === 'goals'
  if (!keyed || parts.length < 3 || !parts[2] || parts[2] === '-') return path
  parts[2] = encodeSegment(normalizeProfileKey(decodeSegment(parts[2])))
  return parts.join('/')
}

/**
 * A patch operation with its path and value in the new names. The value is a
 * bare token or a fact envelope (`{ value, … }`), as the producers emit both;
 * `/unknowns/-` appends a key, so its value is a key.
 */
export function normalizeProfilePatchOperation<Op extends { path: string; value?: unknown }>(operation: Op): Op {
  const path = normalizeProfilePatchPath(operation.path)
  const parts = path.split('/')
  let value = operation.value
  if (parts[1] === 'unknowns' && typeof value === 'string') {
    value = normalizeProfileKey(value)
  } else if (parts[1] === 'facts' || parts[1] === 'assumptions' || parts[1] === 'goals') {
    if (parts.length === 3 && parts[2]) {
      value = normalizeEntryOrValue(decodeSegment(parts[2]), value)
    } else if (parts.length >= 4 && parts[3] === 'value') {
      value = normalizeProfileValue(decodeSegment(parts[2]), value)
    }
  }
  return path === operation.path && value === operation.value ? operation : { ...operation, path, value }
}

function normalizeEntryOrValue(key: string, value: unknown): unknown {
  return isRecord(value) && 'value' in value ? normalizeEntry(key, value) : normalizeProfileValue(key, value)
}

/**
 * The prompt view lists `- key=value` (confirmed, goals, assumptions), `- key`
 * (unknown) and `- key: value | alternativ: value` (contested) lines, parsed by
 * the Python agent. Rewrites the key and the tokens of each legacy line.
 */
export function normalizeLegacyPromptView(view: string): string {
  return view.replace(/^(- )([a-z0-9_]+(?:@[a-z0-9_]+)*)(.*)$/gm, (_line, lead: string, key: string, rest: string) => {
    const next = normalizeProfileKey(key)
    const base = next.split('@')[0]
    const values = rest.replace(/(=|: |alternativ: )([a-z0-9_,]+)/g, (_m, sep: string, tokens: string) => {
      const mapped = tokens
        .split(',')
        .map((token) => normalizeProfileToken(base, token))
        .join(',')
      return `${sep}${mapped}`
    })
    return `${lead}${next}${values}`
  })
}
