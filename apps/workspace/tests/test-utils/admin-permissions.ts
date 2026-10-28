import { findRoleSpec } from '@/lib/authz/catalog'

/**
 * What an Admin's token carries: the catalog's Admin role, which the deploy
 * provisions into WorkOS. A session fixture that stands for an admin gives it
 * these claims, because the role's name alone grants nothing (ADR-0038's
 * 2026-10-27 amendment). A fresh array each call, so a spec may change its own.
 */
export function adminPermissions(): string[] {
  return [...(findRoleSpec('admin')?.permissions ?? [])]
}
