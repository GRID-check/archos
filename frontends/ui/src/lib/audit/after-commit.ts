/**
 * The audit emit for an act that has already committed: fire and forget.
 *
 * `recordAuditEvent` already never throws on a WorkOS failure; this adds the
 * two things an after-commit call site needs on top. It does not make the act
 * wait on WorkOS (a Piloti turn may set twenty marks in one call), and nothing
 * the emit does, a rejection or a throw before it, reaches the act: the act
 * stood before the trail was asked to record it, so a lost line is logged and
 * the act is not failed or retried.
 */

import 'server-only'
import { recordAuditEvent, type AuditEventInput } from './service'

export function recordAuditEventAfterCommit(input: AuditEventInput): void {
  const lost = (error: unknown) => console.warn(`[Audit] ${input.action} was not recorded:`, error)
  try {
    void Promise.resolve(recordAuditEvent(input)).catch(lost)
  } catch (error) {
    lost(error)
  }
}
