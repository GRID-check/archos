import { describe, expect, it } from 'vitest'
import type { Dossier, DossierFact } from './dossier'
import { deriveDocumentFindings, findingIdentity, type FindingsDocument } from './findings'
import {
  buildingClassNumber,
  federalStateToken,
  germanNumber,
  profileDisagreements,
  type ProfileFacts,
} from './profile-contradictions'

const dossier = (facts: DossierFact[], place: Dossier['place'] = null): Dossier => ({
  documentType: null,
  title: null,
  summary: null,
  parties: [],
  dates: [],
  place,
  facts,
})

const fact = (key: DossierFact['key'], value: string, page: number | null = 1, unit: string | null = null): DossierFact => ({
  key,
  value,
  unit,
  page,
  quote: null,
})

const profile = (facts: Record<string, unknown>): ProfileFacts => ({
  facts: Object.fromEntries(Object.entries(facts).map(([key, value]) => [key, { value }])),
})

const doc = (id: string, name: string, facts: DossierFact[], extra: Partial<FindingsDocument> = {}): FindingsDocument => ({
  id,
  name,
  filename: name,
  superseded: false,
  tags: [],
  dossier: dossier(facts),
  references: [],
  coverage: null,
  documentNumber: null,
  ...extra,
})

describe('the readings', () => {
  it('reads a Gebäudeklasse however it is written', () => {
    expect(buildingClassNumber('GK 4')).toBe(4)
    expect(buildingClassNumber('Gebäudeklasse 3')).toBe(3)
    expect(buildingClassNumber('gk5')).toBe(5)
    expect(buildingClassNumber(2)).toBe(2)
    expect(buildingClassNumber('lt. OIB-RL 2 der Gebäudeklasse 4 zuzuordnen')).toBe(4)
    expect(buildingClassNumber('Fluchtniveau 8 m')).toBeNull()
    expect(buildingClassNumber('GK 6')).toBeNull()
  })

  it('reads a German area figure', () => {
    expect(germanNumber('1.245,5')).toBe(1245.5)
    expect(germanNumber('1.245')).toBe(1245)
    expect(germanNumber('1 245')).toBe(1245)
    expect(germanNumber('812,40')).toBe(812.4)
    expect(germanNumber('ca. 800')).toBeNull()
    expect(germanNumber('800–850')).toBeNull()
  })

  it('reads a Land by its name or its short form', () => {
    expect(federalStateToken('Niederösterreich')).toBe('lower_austria')
    expect(federalStateToken('NÖ')).toBe('lower_austria')
    expect(federalStateToken('Bundesland Salzburg')).toBe('salzburg')
    expect(federalStateToken('Wien')).toBe('vienna')
    expect(federalStateToken('Bayern')).toBeNull()
  })
})

describe('profileDisagreements', () => {
  it('finds a fire safety concept that puts the building one class higher than the Steckbrief', () => {
    const found = profileDisagreements(dossier([fact('building_class', 'GK 4', 2)]), profile({ building_class: 'GK3' }))
    expect(found).toEqual([
      {
        profile: { key: 'building_class', profileKey: 'building_class', display: '3' },
        statements: [{ value: 'GK 4', unit: null, pages: [2] }],
      },
    ])
  })

  it('agrees when the class is written differently but means the same', () => {
    expect(profileDisagreements(dossier([fact('building_class', 'Gebäudeklasse 3')]), profile({ building_class: 3 }))).toEqual([])
  })

  it('compares storeys with every building of the project', () => {
    const twoBuildings = profile({ 'storeys_above_ground@bldg1': 3, 'storeys_above_ground@bldg2': 5 })
    expect(profileDisagreements(dossier([fact('storeys_above_ground', '5')]), twoBuildings)).toEqual([])
    expect(profileDisagreements(dossier([fact('storeys_above_ground', '4', 3)]), twoBuildings)[0]?.profile).toEqual({
      key: 'storeys_above_ground',
      profileKey: 'storeys_above_ground',
      display: '3, 5',
    })
  })

  it('leaves a storey count it cannot read for certain alone', () => {
    expect(profileDisagreements(dossier([fact('storeys_above_ground', '4 + DG')]), profile({ storeys_above_ground: 3 }))).toEqual([])
  })

  it('reads a plot area in m² with a tolerance for rounding', () => {
    const plot = profile({ plot_area: 812.4 })
    expect(profileDisagreements(dossier([fact('plot_area', '812', 1, 'm²')]), plot)).toEqual([])
    expect(profileDisagreements(dossier([fact('plot_area', '1.245,5', 1, 'm²')]), plot)).toHaveLength(1)
    // Another unit is not read: an area in ha is no figure to compare with m².
    expect(profileDisagreements(dossier([fact('plot_area', '0,12', 1, 'ha')]), plot)).toEqual([])
  })

  it('maps the Bauweise onto the intake tokens and shows the intake label', () => {
    const timber = profile({ construction_method: ['timber'] })
    expect(profileDisagreements(dossier([fact('construction_method', 'Holzmassivbau (Brettsperrholz)')]), timber)).toEqual([])
    const found = profileDisagreements(dossier([fact('construction_method', 'Stahlbeton-Skelettbau', 4)]), timber)
    expect(found[0]?.profile.display).toBe('Holzbau')
    expect(found[0]?.statements).toEqual([{ value: 'Stahlbeton-Skelettbau', unit: null, pages: [4] }])
    // A word that names no single Bauweise says nothing.
    expect(profileDisagreements(dossier([fact('construction_method', 'Mischbauweise')]), timber)).toEqual([])
  })

  it('reads a legacy German token in the profile as the token it became', () => {
    expect(profileDisagreements(dossier([fact('construction_method', 'Holzbau')]), profile({ construction_method: 'holzbau' }))).toEqual([])
  })

  it('takes a use the profile lists among others as agreeing', () => {
    const mixed = profile({ uses: ['residential', 'office'] })
    expect(profileDisagreements(dossier([fact('use', 'Wohnhaus mit Büros im EG')]), mixed)).toEqual([])
    expect(profileDisagreements(dossier([fact('use', 'Hotel')]), mixed)[0]?.profile.display).toBe('Wohnen, Büro / Verwaltung')
    // A garage is part of many buildings and names no use to compare.
    expect(profileDisagreements(dossier([fact('use', 'Tiefgarage')]), mixed)).toEqual([])
  })

  it('compares the Land of the document’s place', () => {
    const found = profileDisagreements(dossier([], { state: 'Niederösterreich' }), profile({ federal_state: 'vienna' }))
    expect(found).toEqual([
      {
        profile: { key: 'federal_state', profileKey: 'federal_state', display: 'Wien' },
        statements: [{ value: 'Niederösterreich', unit: null, pages: [] }],
      },
    ])
    expect(profileDisagreements(dossier([], { state: 'NÖ' }), profile({ federal_state: 'outside_austria' }))).toEqual([])
  })

  it('compares only what a person confirmed, and nothing still „offen“', () => {
    expect(profileDisagreements(dossier([fact('building_class', 'GK 4')]), { facts: {} })).toEqual([])
    expect(profileDisagreements(dossier([fact('construction_method', 'Holzbau')]), profile({ construction_method: 'open' }))).toEqual([])
  })

  it('takes a document that states a key twice as agreeing when one value agrees', () => {
    const found = profileDisagreements(
      dossier([fact('storeys_above_ground', '4', 2), fact('storeys_above_ground', '3', 5)]),
      profile({ storeys_above_ground: 3 })
    )
    expect(found).toEqual([])
  })
})

describe('the profile_contradiction finding', () => {
  const projectProfile = profile({ building_class: 'GK3', storeys_above_ground: 4 })

  it('names every current document that disagrees, first among the findings', () => {
    const documents = [
      doc('fire', 'Brandschutzkonzept.pdf', [fact('building_class', 'GK 4', 2)]),
      doc('description', 'Baubeschreibung.pdf', [fact('building_class', 'Gebäudeklasse 4', 3), fact('storeys_above_ground', '4', 2)]),
      doc('old', 'Brandschutzkonzept_V1.pdf', [fact('building_class', 'GK 5', 1)], { superseded: true }),
      doc('ep', 'EP-05 Grundriss EG.pdf', [fact('storeys_above_ground', '5', 1)]),
    ]
    const findings = deriveDocumentFindings(documents, projectProfile)
    expect(findings[0]).toEqual({
      kind: 'profile_contradiction',
      subject: 'building_class',
      profileKey: 'building_class',
      profileValue: '3',
      sources: [
        { documentId: 'description', name: 'Baubeschreibung.pdf', pages: [3], value: 'Gebäudeklasse 4', unit: null },
        { documentId: 'fire', name: 'Brandschutzkonzept.pdf', pages: [2], value: 'GK 4', unit: null },
      ],
    })
    expect(findings[1]).toMatchObject({
      kind: 'profile_contradiction',
      subject: 'storeys_above_ground',
      sources: [{ documentId: 'ep', value: '5' }],
    })
    expect(findingIdentity(findings[0])).toBe('profile_contradiction:building_class')
  })

  it('compares nothing without a profile', () => {
    const documents = [doc('fire', 'Brandschutzkonzept.pdf', [fact('building_class', 'GK 4', 2)])]
    expect(deriveDocumentFindings(documents)).toEqual([])
  })
})
