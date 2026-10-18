import { describe, expect, it } from 'vitest'
import { AUSTRIAN_DEFAULT_CONVENTIONS, docTypesByFolder, officeConventions } from './conventions'
import type { OfficeFolderRow } from './repository'

const row = (projectId: string, id: string, path: string, extra: Partial<OfficeFolderRow> = {}): OfficeFolderRow => ({
  id,
  projectId,
  parentId: null,
  path,
  description: null,
  accessMode: 'inherit',
  ...extra,
})

describe('officeConventions', () => {
  it('learns the folders the office keeps, the most widely kept first, with the description most give it', () => {
    const conventions = officeConventions(
      [
        row('p1', 'a1', 'Bescheide', { description: 'Bescheide der Behörden' }),
        row('p2', 'b1', 'bescheide', { description: 'Bescheide der Behörden' }),
        row('p3', 'c1', 'Bescheide', { description: 'Alles von der MA 37' }),
        row('p1', 'a2', 'Fotos'),
      ],
      []
    )
    expect(conventions).toEqual([
      { path: 'Bescheide', description: 'Bescheide der Behörden', projects: 3, docTypes: [] },
      { path: 'Fotos', description: null, projects: 1, docTypes: [] },
    ])
  })

  it('leaves out a folder under an own access list, and everything below it', () => {
    const conventions = officeConventions(
      [
        row('p1', 'a1', 'Honorare', { accessMode: 'custom' }),
        row('p1', 'a2', 'Honorare/2026', { parentId: 'a1' }),
        row('p1', 'a3', 'Pläne'),
      ],
      []
    )
    expect(conventions.map((entry) => entry.path)).toEqual(['Pläne'])
  })

  it('offers no convention the shelf already has, and the Austrian default only when there is nothing to learn', () => {
    expect(officeConventions([row('p1', 'a1', 'Pläne')], ['plÄne'])).toEqual(
      AUSTRIAN_DEFAULT_CONVENTIONS.filter((entry) => entry.path !== 'Pläne')
    )
    const fallback = officeConventions([], ['Einreichung'])
    expect(fallback.map((entry) => entry.path)).not.toContain('Einreichung')
    expect(fallback.map((entry) => entry.path)).toContain('Behörde und Bescheide')
  })

  it('carries the Dokumentarten the office files in each', () => {
    const types = docTypesByFolder([
      { folderPath: 'Bescheide', tags: ['Bescheid', 'Brandschutz'] },
      { folderPath: 'bescheide', tags: ['Bescheid'] },
      { folderPath: 'Bescheide', tags: ['Gutachten'] },
      { folderPath: 'Bescheide', tags: ['Sonstiges'] },
    ])
    expect(types.get('bescheide')).toEqual(['Bescheid', 'Gutachten'])
    expect(officeConventions([row('p1', 'a1', 'Bescheide')], [], types)[0].docTypes).toEqual(['Bescheid', 'Gutachten'])
  })
})
