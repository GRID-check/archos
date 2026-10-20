/**
 * What the create dialog took, as step 1 shows it: the address with its
 * Gemeinde and Bundesland, and the short description. Pure, read from the
 * intake view the frame hands every step.
 *
 * The profile is the record and the intake row is what the dialog was given.
 * So a value on the profile wins (the address as `site_address`, the
 * description as `context_description`, both written through the review's
 * decisions, the profile's one door), and the intake row fills in what the
 * profile does not hold: the dialog's description, and the Gemeinde, which is
 * no profile fact. The Gemeinde is shown only while the address is still the
 * geocoder's hit; once a person changed the address it would describe another
 * place.
 */

import type { GeocodeResult } from '@/lib/geocoding/types'
import type { IntakeView, Suggestion } from '@/lib/project-intake/types'

/** The profile keys step 1 reads and writes. */
export const ADDRESS_KEY = 'site_address'
export const FEDERAL_STATE_KEY = 'federal_state'
export const COUNTRY_KEY = 'country'
export const DESCRIPTION_KEY = 'context_description'

export interface DialogFacts {
  address: string | null
  /** „Wien", or null when no hit was chosen and nobody named the Gemeinde. */
  municipality: string | null
  /** The Bundesland as a person reads it („Niederösterreich"). */
  federalState: string | null
  /** Whether the Bundesland is still only Piloti's suggestion. */
  federalStateSuggested: boolean
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
  const federalStateItem = profileItem(view, FEDERAL_STATE_KEY)
  return {
    address,
    municipality: fromHit ? location.municipality : null,
    federalState: text(federalStateItem) ?? (fromHit ? location.state : null),
    federalStateSuggested: federalStateItem?.state === 'suggested',
    description: text(profileItem(view, DESCRIPTION_KEY)) ?? view.description,
  }
}
