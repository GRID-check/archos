/**
 * The kinds of inbox item a person can switch push notifications on or off for,
 * and the person-level choices around them (ADR-0112).
 *
 * No `'server-only'` and no registry import: the settings section in the
 * browser and the job on the server read the same words, and the browser must
 * not pull the server registry in for a list of five.
 *
 * Five categories rather than one toggle per item type. The registry has two
 * dozen types, most of them worded differently for the same intent, and a
 * person asks "tell me when someone needs me", not "tell me about
 * `piloti.intake_ready`". The registry assigns each type a category
 * (`INBOX_TYPE_DEFINITIONS[type].push`), so a new type joins an existing switch
 * and `tsc` fails until it names one.
 */

import { z } from 'zod'

export const PUSH_CATEGORIES = ['requests', 'results', 'access', 'activity', 'office'] as const
export type PushCategory = (typeof PUSH_CATEGORIES)[number]

/**
 * What a category does for a person who never opened the settings.
 *
 * On for what is addressed to them: a request waiting for their answer, the
 * outcome of work they asked for, access they were given, a notice about their
 * office. Off for ambient activity (new messages in a thread, a finished
 * upload, a new Fassung of a document they follow), which would train people to
 * mute the whole channel.
 */
export const PUSH_CATEGORY_DEFAULTS: Readonly<Record<PushCategory, boolean>> = {
  requests: true,
  results: true,
  access: true,
  activity: false,
  office: true,
}

/** What the push service is told about how soon the device should wake for a message. */
export type PushUrgency = 'high' | 'normal' | 'low'

/**
 * A person's choices, resolved: every field present.
 *
 * `showContent` is the lock-screen preview. Off, a notification says only that
 * something arrived in Piloti and carries no title, name or excerpt from the
 * item (`lib/push/payload.ts`).
 */
export interface PushPreferences {
  showContent: boolean
  categories: Record<PushCategory, boolean>
}

export const DEFAULT_PUSH_PREFERENCES: PushPreferences = {
  showContent: true,
  categories: { ...PUSH_CATEGORY_DEFAULTS },
}

/** What a request may change. Absent fields stay as they are. */
export const pushPreferencesPatchSchema = z
  .object({
    showContent: z.boolean().optional(),
    categories: z
      .object({
        requests: z.boolean().optional(),
        results: z.boolean().optional(),
        access: z.boolean().optional(),
        activity: z.boolean().optional(),
        office: z.boolean().optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
export type PushPreferencesPatch = z.infer<typeof pushPreferencesPatchSchema>

/**
 * Read the stored bag (`user_preferences.prefs.pushNotifications`), tolerantly.
 *
 * The bag is opaque JSON the browser could also write through
 * `/api/user/preferences`, so anything that is not a boolean in a known slot is
 * the default rather than a crash or a surprise opt-in.
 */
export function resolvePushPreferences(raw: unknown): PushPreferences {
  const bag = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}
  const stored =
    typeof bag.categories === 'object' && bag.categories !== null ? (bag.categories as Record<string, unknown>) : {}
  const categories = { ...PUSH_CATEGORY_DEFAULTS }
  for (const category of PUSH_CATEGORIES) {
    const value = stored[category]
    if (typeof value === 'boolean') categories[category] = value
  }
  return { showContent: typeof bag.showContent === 'boolean' ? bag.showContent : true, categories }
}

/** Apply a patch to resolved choices. */
export function applyPushPreferencesPatch(current: PushPreferences, patch: PushPreferencesPatch): PushPreferences {
  const categories = { ...current.categories }
  for (const category of PUSH_CATEGORIES) {
    const value = patch.categories?.[category]
    if (typeof value === 'boolean') categories[category] = value
  }
  return { showContent: patch.showContent ?? current.showContent, categories }
}
