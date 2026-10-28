/**
 * Conversation topic tags (Historie chat naming + tag filter).
 *
 * A small, FIXED vocabulary of OIB-Richtlinien topic areas. The backend's
 * title/tag LLM call is constrained to return only these keys, and the
 * Historie filter maps each key to a localised label + source-family colour.
 *
 * Keys are stable, language-neutral slugs — they are what lands in the
 * `conversations.tags` text[] column, so renaming one is a data migration
 * (0168 renamed them to English). The seven topic keys track the OIB
 * Richtlinien 1–6 (plus a general bucket):
 *   structural        → OIB 1  Mechanische Festigkeit & Standsicherheit
 *   fire_safety       → OIB 2  Brandschutz
 *   hygiene           → OIB 3  Hygiene, Gesundheit & Umweltschutz
 *   safety_in_use     → OIB 4  Nutzungssicherheit
 *   accessibility     → OIB 4  Barrierefreiheit
 *   sound_insulation  → OIB 5  Schallschutz
 *   energy            → OIB 6  Energieeinsparung & Wärmeschutz
 *   general           → cross-cutting / no single OIB topic
 */

export const CONVERSATION_TAG_KEYS = [
  'fire_safety',
  'sound_insulation',
  'accessibility',
  'energy',
  'structural',
  'hygiene',
  'safety_in_use',
  'general',
] as const

export type ConversationTagKey = (typeof CONVERSATION_TAG_KEYS)[number]

const TAG_KEY_SET: ReadonlySet<string> = new Set(CONVERSATION_TAG_KEYS)

/**
 * The keys as they were stored before migration 0168. A conversation titled by
 * an older pod, a stored feedback filter and a bookmarked link can still carry
 * one; `normalizeConversationTags` and `canonicalConversationTagKey` map it so
 * the German key is never written again. Remove after one release.
 */
export const LEGACY_CONVERSATION_TAG_KEYS: Readonly<Record<string, ConversationTagKey>> = {
  brandschutz: 'fire_safety',
  schallschutz: 'sound_insulation',
  barrierefreiheit: 'accessibility',
  energie: 'energy',
  statik: 'structural',
  nutzungssicherheit: 'safety_in_use',
  allgemein: 'general',
}

/** The current key for a value that may be a legacy one; anything else passes through for validation. */
export const canonicalConversationTagKey = (value: string): string => LEGACY_CONVERSATION_TAG_KEYS[value] ?? value

/** Narrow an arbitrary string to a known tag key. */
export function isConversationTagKey(value: string): value is ConversationTagKey {
  return TAG_KEY_SET.has(value)
}

/**
 * Keep only known tag keys, de-duplicated and order-preserving. Used to
 * sanitise whatever the LLM (or a legacy row) hands back before it is stored
 * or rendered — the UI must never try to render an unknown chip.
 */
export function normalizeConversationTags(values: readonly string[]): ConversationTagKey[] {
  const seen = new Set<ConversationTagKey>()
  for (const value of values) {
    const key = canonicalConversationTagKey(value.trim().toLowerCase())
    if (isConversationTagKey(key)) seen.add(key)
  }
  return [...seen]
}
