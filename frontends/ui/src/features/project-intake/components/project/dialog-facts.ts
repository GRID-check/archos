/**
 * What the create dialog took, as step 1 shows it: the address with its
 * Gemeinde and Bundesland, and the short description. Pure, read from the
 * intake view the frame hands every step.
 *
 * The profile is the record and the intake row is what the dialog was given.
 * So a value on the profile wins (the address as `standort_adresse`, the
 * description as `kontext_beschreibung`, both written through the review's
 * decisions, the profile's one door), and the intake row fills in what the
 * profile does not hold: the dialog's description, and the Gemeinde, which is
 * no profile fact. The Gemeinde is shown only while the address is still the
 * geocoder's hit; once a person changed the address it would describe another
 * place.
 */

import type { GeocodeResult } from '@/lib/geocoding/types'
import type { IntakeView, Suggestion } from '@/lib/project-intake/types'

/** The profile keys step 1 reads and writes. */
export const ADDRESS_KEY = 'standort_adresse'
export const BUNDESLAND_KEY = 'bundesland'
export const COUNTRY_KEY = 'country'
export const DESCRIPTION_KEY = 'kontext_beschreibung'

export interface DialogFacts {
  address: string | null
  /** „Wien", or null when no hit was chosen and nobody named the Gemeinde. */
  gemeinde: string | null
  /** The Bundesland as a person reads it („Niederösterreich"). */
  bundesland: string | null
  /** Whether the Bundesland is still only Piloti's suggestion. */
  bundeslandSuggested: boolean
  description: string | null
}

function profileItem(view: IntakeView, key: string): Suggestion | null {
  for (const group of view.groups) {
    const item = group.items.find((entry) => entry.key === key)
    if (item) return item
  }
  return view.contradictions.find((entry) => entry.key === key) ?? null
}

const text = (item: Suggestion | null): string | null => {
  const value = item?.display.trim()
  return value ? value : null
}

export function dialogFacts(view: IntakeView): DialogFacts {
  const location: GeocodeResult | null = view.location
  const address = text(profileItem(view, ADDRESS_KEY)) ?? location?.label ?? null
  const fromHit = location !== null && address === location.label
  const bundeslandItem = profileItem(view, BUNDESLAND_KEY)
  return {
    address,
    gemeinde: fromHit ? location.gemeinde : null,
    bundesland: text(bundeslandItem) ?? (fromHit ? location.state : null),
    bundeslandSuggested: bundeslandItem?.state === 'suggested',
    description: text(profileItem(view, DESCRIPTION_KEY)) ?? view.description,
  }
}
