import { describe, expect, test, vi } from 'vitest'
import { render, screen } from '@/test-utils'
import { en } from '@/i18n/dictionaries/en'
import { de } from '@/i18n/dictionaries/de'
import { PROJECT_SETTINGS_SECTION_KEYS, visibleSettingsSections } from '../../lib/settings-sections'
import { ProjectSettingsNav } from './project-settings-nav'

vi.mock('next/navigation', () => ({ usePathname: () => '/app/projects/p1/settings/piloti' }))

describe('ProjectSettingsNav', () => {
  test('„Was Piloti tut“ sits right after the Overview and leads to its section', () => {
    render(
      <ProjectSettingsNav
        projectId="p1"
        sections={visibleSettingsSections({ manageMembers: false, manageBudget: false })}
      />
    )

    const labels = screen.getAllByRole('link').map((link) => link.textContent)
    expect(labels.slice(0, 2)).toEqual(['Overview', 'What Piloti is doing'])
    expect(screen.getByRole('link', { name: 'What Piloti is doing' })).toHaveAttribute(
      'href',
      '/app/projects/p1/settings/piloti'
    )
  })

  test('every reader gets the entry, whatever else they may open', () => {
    expect(visibleSettingsSections({ manageMembers: false, manageBudget: false })).toContain(
      'piloti'
    )
    expect(visibleSettingsSections({ manageMembers: true, manageBudget: true })).toContain('piloti')
  })

  test('every section has a label in both languages, so no entry draws as a key', () => {
    for (const key of PROJECT_SETTINGS_SECTION_KEYS) {
      expect(en.settings.project.nav[key]).toEqual(expect.any(String))
      expect(de.settings.project.nav[key]).toEqual(expect.any(String))
    }
    expect(de.settings.project.nav.piloti).toBe('Was Piloti tut')
  })
})
