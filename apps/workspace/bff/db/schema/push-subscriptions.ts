import { index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'

/**
 * `push_subscriptions` — one browser, on one device, that a person asked to be
 * told about their inbox on (migration 0147, ADR-0112).
 *
 * The endpoint is the push service's address for ONE browser installation, so
 * it is unique across the whole table, not per organization: a device belongs
 * to whoever registered it last. A shared computer where B signs in after A
 * would otherwise keep sending A's notifications to B's screen. Registering an
 * endpoint therefore first removes the rows a different person or organization
 * holds for it (`lib/push/repository.ts`, the only cross-tenant statement here).
 *
 * `p256dh` and `auth` are the subscription's public encryption key and secret:
 * with the endpoint they are all a sender needs to encrypt a payload for this
 * browser, and nothing here can read a notification once sent. The label is a
 * human name for the device ("Safari auf iPhone") made from the user agent, so a
 * person can tell their devices apart when they remove one.
 *
 * A subscription dies on the push service's 404 or 410 (`lib/push/sender.ts`)
 * and after `failure_count` consecutive failures (`lib/push/service.ts`).
 */
export const pushSubscriptions = pgTable(
  'push_subscriptions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: text('organization_id').notNull(),
    userId: text('user_id').notNull(),
    endpoint: text('endpoint').notNull(),
    p256dh: text('p256dh').notNull(),
    auth: text('auth').notNull(),
    deviceLabel: text('device_label').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastSuccessAt: timestamp('last_success_at', { withTimezone: true }),
    failureCount: integer('failure_count').notNull().default(0),
  },
  (table) => ({
    endpoint: uniqueIndex('uniq_push_subscriptions_endpoint').on(table.endpoint),
    person: index('idx_push_subscriptions_person').on(table.organizationId, table.userId),
  })
)

export type PushSubscriptionRow = typeof pushSubscriptions.$inferSelect
export type NewPushSubscription = typeof pushSubscriptions.$inferInsert
