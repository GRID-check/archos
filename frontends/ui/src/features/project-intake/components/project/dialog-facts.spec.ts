/**
 * What step 1 shows of the create dialog, and what an edit writes: the profile
 * wins over the intake row, the Gemeinde is shown only for the geocoder's own
 * hit, and an edit sends only what changed.
 */
import { describe, expect, test } from 'vitest'
import { FIXTURE_DESCRIPTION, FIXTURE_LOCATION, INTAKE_WAITING } from '@/app/dev/_fixtures/project-intake'
import type { IntakeView, Suggestion } from '@/lib/project-intake/types'
import { dialogFacts } from './dialog-facts'
import { factDecisions } from './dialog-facts-section'

const item = (key: string, display: string, state: Suggestion['state'] = 'confirmed'): Suggestion => ({
  key,
  baseKey: key,
  bauwerkId: null,
  label: key,
  value: display,
  display,
  state,
  evidence: [],
  alternatives: [],
  decisive: false,
})

const withItems = (view: IntakeView, items: Suggestion[]): IntakeView => ({ ...view, groups: [{ stage: 'A', title: 'Projektbasis', items }] })

describe('dialogFacts', () => {
  test("a project just created: the geocoder's address with its Gemeinde and Bundesland, and the dialog's description", () => {
    expect(dialogFacts(INTAKE_WAITING)).toEqual({
      address: FIXTURE_LOCATION.label,
      municipality: 'Wien',
      federalState: 'Wien',
      federalStateSuggested: false,
      description: FIXTURE_DESCRIPTION,
    })
  })

  test('an address a person changed hides the Gemeinde of the old hit; the profile names the Bundesland', () => {
    const view = withItems(INTAKE_WAITING, [item('site_address', 'Hauptplatz 1, 3100 St. Pölten'), item('federal_state', 'Niederösterreich', 'suggested')])
    expect(dialogFacts(view)).toMatchObject({
      address: 'Hauptplatz 1, 3100 St. Pölten',
      municipality: null,
      federalState: 'Niederösterreich',
      federalStateSuggested: true,
    })
  })

  test("the profile's description wins over the dialog's", () => {
    expect(dialogFacts(withItems(INTAKE_WAITING, [item('context_description', 'Neubau eines Kindergartens')])).description).toBe('Neubau eines Kindergartens')
  })

  test('nothing typed in the dialog reads as nothing', () => {
    expect(dialogFacts({ ...INTAKE_WAITING, groups: [], location: null, description: null })).toEqual({
      address: null,
      municipality: null,
      federalState: null,
      federalStateSuggested: false,
      description: null,
    })
  })
})

describe('factDecisions', () => {
  const before = { address: FIXTURE_LOCATION.label, description: FIXTURE_DESCRIPTION }

  test('nothing changed, nothing sent', () => {
    expect(factDecisions(before, { address: { text: FIXTURE_LOCATION.label, place: null }, description: FIXTURE_DESCRIPTION })).toEqual([])
  })

  test('a typed address is the address alone; the Bundesland stays the reading’s to find', () => {
    expect(factDecisions(before, { address: { text: ' Hauptplatz 1, St. Pölten ', place: null }, description: FIXTURE_DESCRIPTION })).toEqual([
      { key: 'site_address', action: 'answer', value: 'Hauptplatz 1, St. Pölten' },
    ])
  })

  test('a chosen hit brings its Land and Bundesland along', () => {
    const place = { ...FIXTURE_LOCATION, label: 'Hauptplatz 1, 3100 St. Pölten', federalState: 'lower_austria', state: 'Niederösterreich' }
    expect(factDecisions({ address: null, description: null }, { address: { text: place.label, place }, description: '' })).toEqual([
      { key: 'site_address', action: 'answer', value: place.label },
      { key: 'country', action: 'answer', value: 'at' },
      { key: 'federal_state', action: 'answer', value: 'lower_austria' },
    ])
  })

  test('a description is written to the profile; emptying a field never erases a value', () => {
    expect(factDecisions(before, { address: { text: '', place: null }, description: 'Zubau' })).toEqual([
      { key: 'context_description', action: 'answer', value: 'Zubau' },
    ])
  })
})
