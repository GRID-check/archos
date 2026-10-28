/**
 * @vitest-environment node
 */
/**
 * Every permission a custom role can carry has a human label, in both
 * languages. A new organization permission in the catalog fails here until
 * somebody writes the line an office will read in the role editor.
 */
import { describe, expect, it } from 'vitest'
import { ORG_PERMISSION_SPECS } from '@/lib/authz/catalog'
import { translatorFor } from '@/i18n/namespace'
import { organizationCopy } from '@/i18n/namespaces/organization'
import { PERMISSION_LABEL_KEYS, permissionLabel } from './permission-labels'

const ORG_TIER = ORG_PERMISSION_SPECS.filter((spec) => spec.tier === 'org').map((spec) => spec.slug)

describe('permission labels', () => {
  it('labels exactly the organization tier of the catalog', () => {
    expect(Object.keys(PERMISSION_LABEL_KEYS).sort()).toEqual([...ORG_TIER].sort())
  })

  it.each(['en', 'de'] as const)('resolves a name and a hint for every label in %s', (locale) => {
    const t = translatorFor(organizationCopy, locale)
    for (const slug of ORG_TIER) {
      const label = permissionLabel(t, slug)
      expect(label.name, slug).not.toMatch(/customRoles\./)
      expect(label.hint, slug).not.toMatch(/customRoles\./)
    }
  })

  it('falls back to the catalog name, then the slug, for a permission it does not label', () => {
    const t = translatorFor(organizationCopy, 'en')
    expect(permissionLabel(t, 'project:view')).toEqual({ name: 'View project', hint: null })
    expect(permissionLabel(t, 'org:unknown')).toEqual({ name: 'org:unknown', hint: null })
  })
})
