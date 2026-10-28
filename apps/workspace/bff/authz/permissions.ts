/**
 * Permission registry — the slugs the app checks, derived from the catalog
 * (`./catalog`, ADR-0038) so code and WorkOS provisioning can never disagree.
 *
 * Authorization is PERMISSION-driven, not role-driven: routes ask "does this
 * session hold `org:models:manage`?", never "is the role called admin?".
 * Roles are permission bundles managed in WorkOS — creating a new one there
 * (say a billing admin holding only `org:budgets:manage`) works with no code
 * change. That is the extensibility contract, and the catalog now ships four
 * such roles so the contract is exercised rather than merely asserted.
 *
 * Org- and platform-tier permissions arrive in the AuthKit JWT `permissions`
 * claim for the active organization and are checked with zero I/O. Project-tier
 * permissions are per-resource and go through WorkOS FGA — see `./decide` for
 * the single entry point across the tiers.
 */

import type { UserSession } from '@/lib/auth/types'
import {
  ORG_PERMISSION_SPECS,
  PLATFORM_PERMISSION_SPECS,
  PROJECT_PERMISSION_SPECS,
  FOLDER_PERMISSION_SPECS,
} from './catalog'

/** Organization-tier permissions (attached to org roles, e.g. Admin). */
export const ORG_PERMISSIONS = {
  /** Manage org settings: name, locale, defaults; see the org page. */
  settingsManage: 'org:settings:manage',
  /** Manage runtime AI model configuration (ADR-0014). */
  modelsManage: 'org:models:manage',
  /** Manage LLM budgets and view org-wide usage (ADR-0015). */
  budgetsManage: 'org:budgets:manage',
  /** Manage legal holds and the deletion queue. */
  complianceManage: 'org:compliance:manage',
  /** View the org's audit trail (native WorkOS Audit Logs viewer/exports). */
  auditView: 'org:audit:view',
  /** Read the download log: who took which document out (ADR-0088). Reading it is audited. */
  downloadLogView: 'org:downloads:view',
  /** Manage the org-wide office shelf (upload/delete/reingest/retag). */
  officeShelfManage: 'org:office_shelf:manage',
  /** Author/edit/delete skills in the org toolbox (Agent Skills). */
  skillsManage: 'org:skills:manage',
  /** Create new projects in the organization. */
  projectsCreate: 'org:projects:create',
  /** See and manage who is in the organization and what role they hold. */
  membersManage: 'org:members:manage',
  /**
   * Reach every project in the organization without a per-project role — the
   * org-admin bypass, expressed as a permission (ADR-0038). Checking a
   * permission rather than the role slug `admin` is what makes a restricted
   * admin, or a custom owner role, constructible for the project tier too.
   */
  projectsAdminister: 'org:projects:administer',
} as const

/**
 * Platform-tier permissions. Only ever attached to roles of the dedicated
 * GRID Platform organization, so no tenant admin can grant them. The binding
 * guarantee is the platform-org membership check in `./platform` — WorkOS
 * cannot express "attachable only to one organization's roles".
 */
export const PLATFORM_PERMISSIONS = {
  organizationsView: 'platform:organizations:view',
  organizationsManage: 'platform:organizations:manage',
  usageView: 'platform:usage:view',
  /** Read platform configuration. The read half of {@link settingsManage}. */
  settingsView: 'platform:settings:view',
  settingsManage: 'platform:settings:manage',
  /**
   * Read the platform's LLM observability (Langfuse) and nothing else. Checked
   * at the edge, not in the app: the Envoy SecurityPolicy in front of Langfuse
   * admits it beside `organizationsView` (deploy/pulumi/src/platform/platform-oidc.ts,
   * `OBSERVABILITY_VIEW_PERMISSION`), and Langfuse's own roles take it from
   * there.
   */
  observabilityView: 'platform:observability:view',
} as const

/** Project-tier permissions, checked per project via WorkOS FGA. */
export const PROJECT_PERMISSIONS = {
  view: 'project:view',
  chat: 'project:chat',
  /** @deprecated Umbrella write kept for existing grants; prefer the specific ones. */
  edit: 'project:edit',
  documentsWrite: 'project:documents:write',
  /**
   * Machine authorship. Required IN ADDITION to `documentsWrite` at the
   * generated-document seam (`lib/documents/generated.ts`), so an organization
   * can stop the agent filing without stopping its own people uploading.
   */
  documentsGenerate: 'project:documents:generate',
  memoryWrite: 'project:memory:write',
  manage: 'project:manage',
  membersManage: 'project:members:manage',
  skillsManage: 'project:skills:manage',
} as const

/** Folder tier (ADR-0097): held through a folder role on a folder with its own list. */
export const FOLDER_PERMISSIONS = {
  read: 'folder:read',
  write: 'folder:write',
} as const

export type OrgPermission = (typeof ORG_PERMISSIONS)[keyof typeof ORG_PERMISSIONS]
export type PlatformPermission = (typeof PLATFORM_PERMISSIONS)[keyof typeof PLATFORM_PERMISSIONS]
export type ProjectPermission = (typeof PROJECT_PERMISSIONS)[keyof typeof PROJECT_PERMISSIONS]
export type FolderPermission = (typeof FOLDER_PERMISSIONS)[keyof typeof FOLDER_PERMISSIONS]

/**
 * A permission answerable from the JWT alone — no resource id, no I/O.
 * These are the only ones a route factory can gate on by itself; per-resource
 * tiers need the resource in hand and go through `./decide`.
 */
export type KnownPermission = OrgPermission | PlatformPermission

/** Any permission `./decide` answers: the claims tiers and the project tier. */
export type AnyPermission = KnownPermission | ProjectPermission

/**
 * Permissions that were renamed: the current slug, then the slugs it used to
 * have. A grant under an old slug still counts for one release, because a custom
 * role built in WorkOS keeps the slug it was given until an operator re-grants
 * it (`docs/deployment/office-shelf-rename-runbook.md`). The ONE place the old
 * names are known; every check that reads a claim or a role goes through
 * {@link acceptedPermissionSlugs}. Remove an entry when the old slug is deleted
 * from the catalog.
 */
const RENAMED_PERMISSIONS: Readonly<Record<string, readonly string[]>> = {
  [ORG_PERMISSIONS.officeShelfManage]: ['org:archiv:manage'],
}

/** Every slug whose grant answers a check for `permission`: itself, then its retired names. */
export function acceptedPermissionSlugs(permission: string): readonly string[] {
  return [permission, ...(RENAMED_PERMISSIONS[permission] ?? [])]
}

/**
 * Whether the session holds a permission for its ACTIVE organization: the
 * AuthKit token's `permissions` claim names it, or a name it was renamed from.
 *
 * The claim is WorkOS's answer, and the only one. The deploy applies the catalog
 * to WorkOS (`grid-app-authz-catalog`), so a role holds in WorkOS what the
 * catalog says, and a session minted before a change catches up at its next
 * refresh, within minutes. There used to be a second answer here, the catalog's
 * permissions for the role SLUG, for sessions minted before provisioning. It
 * handed a role named `admin` the whole Admin bundle whatever WorkOS said it
 * held, and it outlived the gap it was written for.
 */
export function hasPermission(session: Pick<UserSession, 'permissions'>, permission: KnownPermission): boolean {
  return acceptedPermissionSlugs(permission).some((slug) => session.permissions.includes(slug))
}

/** Every permission slug the catalog defines, for provisioning and tests. */
export const ALL_ORG_PERMISSION_SLUGS: readonly string[] = ORG_PERMISSION_SPECS.map(
  (permission) => permission.slug
)
export const ALL_PLATFORM_PERMISSION_SLUGS: readonly string[] = PLATFORM_PERMISSION_SPECS.map(
  (permission) => permission.slug
)
export const ALL_PROJECT_PERMISSION_SLUGS: readonly string[] = PROJECT_PERMISSION_SPECS.map(
  (permission) => permission.slug
)
export const ALL_FOLDER_PERMISSION_SLUGS: readonly string[] = FOLDER_PERMISSION_SPECS.map(
  (permission) => permission.slug
)
