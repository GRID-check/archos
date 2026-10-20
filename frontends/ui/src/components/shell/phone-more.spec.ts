import { describe, expect, test } from 'vitest'

import { moreDestinations, type MoreFlags } from './phone-more'
import { orgPhoneTabs, projectPhoneTabs } from './phone-tabs'

const ALL: MoreFlags = {
  canAccessOfficeShelf: true,
  canAccessInbox: true,
  showSkills: true,
  canViewOrganization: true,
  canManageOrganization: true,
  canManagePlatform: true,
}
const NONE: MoreFlags = {
  canAccessOfficeShelf: false,
  canAccessInbox: false,
  showSkills: false,
  canViewOrganization: false,
  canManageOrganization: false,
  canManagePlatform: false,
}

const FLAG_SETS: MoreFlags[] = [ALL, NONE, { ...ALL, canAccessInbox: false }, { ...ALL, showSkills: false }]

describe('moreDestinations: what "Mehr" lists', () => {
  test.each(FLAG_SETS)('inside a project it never lists a destination the tab bar carries (%j)', (flags) => {
    const barHrefs = projectPhoneTabs('p1', '/app/projects/p1/files', flags)
      .map((tab) => tab.href)
      .filter((href): href is string => href !== null)
      .map((href) => href.split('?')[0])
    const listed = moreDestinations('p1', '/app/projects/p1/files', flags).map((d) => d.href)
    for (const href of listed) expect(barHrefs).not.toContain(href)
  })

  test.each(FLAG_SETS)('above a project it never lists an org tab-bar destination (%j)', (flags) => {
    const barHrefs = orgPhoneTabs('/app/projects', flags)
      .map((tab) => tab.href)
      .filter((href): href is string => href !== null)
    for (const destination of moreDestinations(null, '/app/projects', flags)) {
      expect(barHrefs).not.toContain(destination.href)
    }
  })

  test('in a project it lists the rail sections without a tab, gated as the rail gates them', () => {
    const keys = (flags: MoreFlags) => moreDestinations('p1', '/app/projects/p1/chat', flags).map((d) => d.key)
    expect(keys(ALL)).toEqual(['automation', 'officeShelf', 'profile', 'organization', 'platform'])
    expect(keys(NONE)).toEqual(['profile'])
    expect(keys({ ...ALL, showSkills: false })).not.toContain('automation')
    expect(keys({ ...ALL, canAccessOfficeShelf: false })).not.toContain('officeShelf')
  })

  test('the account links are gated as the avatar menu gates them', () => {
    const keys = (flags: Partial<MoreFlags>) => moreDestinations(null, '/app/projects', { ...NONE, ...flags }).map((d) => d.key)
    expect(keys({})).toEqual(['profile'])
    expect(keys({ canViewOrganization: true })).toEqual(['profile', 'organization'])
    expect(keys({ canManageOrganization: true })).toEqual(['profile', 'organization'])
    expect(keys({ canManagePlatform: true })).toEqual(['profile', 'platform'])
  })
})
