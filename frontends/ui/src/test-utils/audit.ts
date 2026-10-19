/**
 * The check every spec of an audit emitter owes the registry: WorkOS rejects an
 * event whose target types or metadata keys the action's schema does not
 * register, exactly like an unregistered action (issues #255/#256), and the
 * emitter swallows that rejection. A spec that asserts the event's shape
 * asserts it against `schemas.mjs` too, so the two cannot drift apart.
 */

import { expect } from 'vitest'
import type { AuditEventInput } from '@/lib/audit/service'
import { AUDIT_SCHEMAS } from '@/lib/audit/schemas.mjs'

type Registry = Readonly<
  Record<
    string,
    {
      readonly targets: readonly { readonly type: string }[]
      readonly metadata?: Readonly<Record<string, string>>
    }
  >
>

const REGISTRY: Registry = AUDIT_SCHEMAS

/** Every target type and metadata key the event carries is registered for its action. */
export function expectRegistered(input: AuditEventInput): void {
  const schema = REGISTRY[input.action]
  expect(schema, input.action).toBeDefined()
  const registered = schema.targets.map((target) => target.type)
  for (const type of [
    input.targetType,
    ...(input.alsoTargets ?? []).map((target) => target.type),
  ]) {
    expect(registered, `${input.action} target`).toContain(type)
  }
  const keys = Object.keys(schema.metadata ?? {})
  for (const key of Object.keys(input.metadata ?? {}))
    expect(keys, `${input.action} metadata`).toContain(key)
}
