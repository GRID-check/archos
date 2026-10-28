/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'

import { canManageBudgets, canManageCompliance, canManageModels, isOrgAdmin } from './organizations'
import {
  acceptedPermissionSlugs,
  hasPermission,
  ORG_PERMISSIONS,
  PLATFORM_PERMISSIONS,
} from './permissions'

const session = (role: string, permissions: string[] = []) => ({ role, permissions })

describe('permission registry', () => {
  it('grants via explicit permission claims', () => {
    expect(
      hasPermission(session('member', ['org:budgets:manage']), ORG_PERMISSIONS.budgetsManage)
    ).toBe(true)
    expect(hasPermission(session('member'), ORG_PERMISSIONS.budgetsManage)).toBe(false)
  })

  it("a role NAME grants nothing: the token's claim is the only answer", () => {
    // There was a catalog-derived implication from the role slug, so a role
    // named `admin` held the whole Admin bundle whatever WorkOS said it held.
    // The deploy applies the catalog to WorkOS, so the claim already carries it.
    expect(hasPermission(session('admin'), ORG_PERMISSIONS.settingsManage)).toBe(false)
    expect(hasPermission(session('admin'), ORG_PERMISSIONS.projectsAdminister)).toBe(false)
    expect(hasPermission(session('org-auditor'), ORG_PERMISSIONS.auditView)).toBe(false)
  })

  it('a restricted role called admin holds only what WorkOS gave it', () => {
    const restricted = session('admin', ['org:settings:manage'])
    expect(hasPermission(restricted, ORG_PERMISSIONS.settingsManage)).toBe(true)
    expect(hasPermission(restricted, ORG_PERMISSIONS.skillsManage)).toBe(false)
  })

  it('the org-wide project bypass is a permission, held by whatever role carries it', () => {
    expect(hasPermission(session('acme-owner', ['org:projects:administer']), ORG_PERMISSIONS.projectsAdminister)).toBe(true)
    expect(hasPermission(session('admin', ['org:settings:manage']), ORG_PERMISSIONS.projectsAdminister)).toBe(false)
  })

  it('a platform permission is never answered from a tenant session', () => {
    // Platform access is membership of the platform org (lib/authz/platform).
    expect(hasPermission(session('org-platform-owner'), PLATFORM_PERMISSIONS.organizationsView)).toBe(false)
    expect(hasPermission(session('admin', ['org:settings:manage']), PLATFORM_PERMISSIONS.usageView)).toBe(false)
  })

  it('custom roles work through claims alone (extensibility contract)', () => {
    const billingAdmin = session('org-billing-admin', ['org:budgets:manage'])
    expect(canManageBudgets(billingAdmin)).toBe(true)
    expect(canManageModels(billingAdmin)).toBe(false)
    expect(canManageCompliance(billingAdmin)).toBe(false)
    expect(isOrgAdmin(billingAdmin)).toBe(false)
  })

  it('isOrgAdmin honors both org:settings:manage and the legacy widget permission', () => {
    expect(isOrgAdmin(session('member', ['org:settings:manage']))).toBe(true)
    expect(isOrgAdmin(session('member', ['widgets:users-table:manage']))).toBe(true)
    expect(isOrgAdmin(session('member'))).toBe(false)
  })
})

describe('the renamed office-shelf permission', () => {
  it('counts a grant under the old slug as a grant of the new one', () => {
    expect(acceptedPermissionSlugs('org:office_shelf:manage')).toEqual(['org:office_shelf:manage', 'org:archiv:manage'])
    expect(acceptedPermissionSlugs('org:models:manage')).toEqual(['org:models:manage'])
    expect(hasPermission({ permissions: ['org:archiv:manage'] }, ORG_PERMISSIONS.officeShelfManage)).toBe(true)
    expect(hasPermission({ permissions: ['org:office_shelf:manage'] }, ORG_PERMISSIONS.officeShelfManage)).toBe(true)
    expect(hasPermission({ permissions: [] }, ORG_PERMISSIONS.officeShelfManage)).toBe(false)
  })
})
