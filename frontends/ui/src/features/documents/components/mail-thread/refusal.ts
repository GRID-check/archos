/**
 * A refused write on a mail thread, in the tab's words: the server's code
 * (`MAIL_THREAD_REFUSALS`, `details.reason` of a 409; `project-closed` on a
 * follow in a closed project) mapped to its `mailThread.refusals` key, so
 * every refusal is worded in one table and an unknown one says „Das hat
 * nicht geklappt“ rather than the server's English.
 */

import { ApiRequestError } from '@/adapters/api/api-error'
import { MAIL_THREAD_REFUSALS, type MailThreadRefusal } from '@/lib/mail-thread/mail-thread-wire'

export type MailThreadRefusalKey = MailThreadRefusal | 'project_closed' | 'unknown'

export function refusalKey(error: unknown): MailThreadRefusalKey {
  if (!(error instanceof ApiRequestError)) return 'unknown'
  if (error.reason === 'project-closed') return 'project_closed'
  return (MAIL_THREAD_REFUSALS as readonly string[]).includes(error.reason ?? '') ? (error.reason as MailThreadRefusal) : 'unknown'
}
