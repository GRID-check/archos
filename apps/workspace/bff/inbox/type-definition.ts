/**
 * The shape of one inbox item type's definition (ADR-0035, spec IB-5…IB-7):
 * its gate, whether it is actionable, how it groups, how long it is kept, and
 * how it reaches a person by email and push. The definitions themselves are
 * `./registry.ts`'s `INBOX_TYPE_DEFINITIONS`; this module is the vocabulary
 * they are written in, so the registry holds entries and the rules about them.
 */

import type { PushCategory, PushUrgency } from './push-categories'

/**
 * Which product gate a type lives behind.
 *
 * `collaboration` types only exist because the collaboration feature does, and
 * they stay behind its flag (ADR-0032…0035, spec NF-8).
 *
 * `operational` types are the platform telling the tenant something about its
 * own account — a filling disk, and whatever joins it later. Gating those on
 * collaboration would mean the warning silently never fires for a tenant that
 * has not bought a chat feature, which is the opposite of what an operational
 * alert is for. So the gate is a property OF THE TYPE, checked by the read path,
 * rather than a guard on the route: a hardcoded list of exceptions at the route
 * would drift the moment a second operational type is registered.
 *
 * `platform` types are addressed to the people who run the platform, not to a
 * tenant: a member's product feedback, and whatever joins it later. Their rows
 * live in the PLATFORM organization and are never part of a tenant's inbox.
 * They reach a reader through the inbox's platform lane, which opens only for a
 * session holding `PLATFORM_INBOX_PERMISSION` (`./registry.ts`) — see `platformInboxTypes`.
 */
export type InboxTypeGate = 'collaboration' | 'operational' | 'platform'

export interface InboxTypeDefinition {
  /**
   * Actionable items represent an outstanding request against the recipient: they
   * can be RESOLVED by a domain event, and they are what the badge counts.
   * Informational items are read and archived.
   */
  readonly actionable: boolean
  /**
   * Whether occurrences collapse into one counted row.
   *   - `collapse` — one row per (recipient, resource). Twenty new messages in a
   *     thread become one row with count 20 (spec CC-20, IB-8).
   *   - `per-anchor` — one row per (recipient, resource, anchor). Each mention
   *     deserves its own row because each is a separate question.
   */
  readonly grouping: 'collapse' | 'per-anchor'
  /** Days after creation the item may be pruned (spec IB-15). */
  readonly retentionDays: number
  /** Which feature gate this type lives behind. See {@link InboxTypeGate}. */
  readonly gate: InboxTypeGate
  /**
   * The type's default for the email channel (spec IB-5, IB-11). See
   * {@link InboxEmailDefault} and `./delivery`.
   */
  readonly email: InboxEmailDefault
  /**
   * How the type reaches a person's phone or desktop as a system notification
   * (ADR-0112). See {@link InboxPushPolicy} and `./push-policy`.
   */
  readonly push: InboxPushPolicy
}

/**
 * Whether a type ALSO reaches its recipient by email, and when (spec IB-11).
 *
 * The item is what happened; email is one way of telling somebody, so the
 * policy is a property of the type and the row stays the one record. Nothing
 * sends email yet — `./delivery` is the seam a sender plugs into — but every
 * type has to state its answer today, so the day a sender exists no type ships
 * silent by accident and none mails by accident.
 *
 *   - `never`     — in-app only. Ambient activity, FYIs, anything that would
 *                   train people to filter our mail.
 *   - `if-unread` — a reminder: mail the recipient when the row is still unread
 *                   (and not archived, resolved or inert) `afterMinutes` after
 *                   its last activity. `0` means as soon as the sender sees it.
 *                   Reading it in the app first cancels the mail, which is what
 *                   makes it a reminder rather than a copy.
 *
 * A digest mode and per-user overrides (spec IB-12) join this union when there
 * is a sender to honour them.
 */
export type InboxEmailDefault =
  | { readonly send: 'never' }
  | { readonly send: 'if-unread'; readonly afterMinutes: number }

/**
 * How a type is pushed (ADR-0112). Not a yes or no: every type may reach a
 * device the person turned notifications on for, and the person decides per
 * `category` (`./push-categories`), whose default is on for what is addressed to
 * them and off for ambient activity. `urgency` is what the push service is told
 * about how soon the device should wake for it.
 *
 * Unlike the email policy, push has no delay: a notification is only worth
 * sending while the item is unread, and the job that sends it checks that at
 * the moment it runs (`lib/push/inbox-push-job.ts`), which is the same
 * cancellation email gets from reading a row first.
 */
export interface InboxPushPolicy {
  readonly category: PushCategory
  readonly urgency: PushUrgency
  /**
   * The category instead, when the item is about the recipient's OWN thing
   * (its payload says `yours: true`): a reply on a mark they wrote answers
   * them, the way `mention.answered` does, and is not ambient activity.
   */
  readonly yours?: PushCategory
  /**
   * Fold a burst of this type's rows for ONE person into one notification,
   * across resources: the morning's due reminders, fifteen marks carried on to
   * a new document, a mark handed over after another. See {@link InboxPushFold}.
   */
  readonly fold?: InboxPushFold
}

/**
 * How a burst of one type's rows for one person is counted in the one
 * notification that tells them all (`lib/push/fold.ts`): each row's `variant`
 * is counted under a part of the line („3 heute oder morgen fällig, 1
 * überfällig“), worded by `pushFold.parts.<part>` in the type's copy. A
 * variant not listed is counted under `other`.
 */
export interface InboxPushFold {
  readonly parts: Readonly<Record<string, string>>
}
