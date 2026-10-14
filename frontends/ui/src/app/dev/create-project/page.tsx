'use client'

/**
 * The create-project dialog, shown open, so its anatomy is screenshot-
 * reviewable without a database. Submitting calls the real server action and
 * fails without one; the dialog shows its calm error then.
 *
 * The address search and the same-address lookup answer from fixtures here:
 * type „Haupt" for suggestions; the first one has an earlier project.
 */

import { CreateProjectDialog } from '@/components/projects/create-project-dialog'
import type { GeocodingClient } from '@/lib/geocoding/client'
import type { GeocodeResult } from '@/lib/geocoding/types'
import type { SameAddressClient } from '@/lib/projects/same-address-client'

const FIXTURE_RESULTS: GeocodeResult[] = [
  {
    label: 'Hauptstraße 12, 1010 Wien',
    lat: 48.2085,
    lon: 16.3731,
    country: 'at',
    bundesland: 'wien',
    state: 'Wien',
    gemeinde: 'Wien',
    postcode: '1010',
    kind: 'address',
  },
  {
    label: 'Hauptstraße 3, 2340 Mödling',
    lat: 48.0856,
    lon: 16.2867,
    country: 'at',
    bundesland: 'niederoesterreich',
    state: 'Niederösterreich',
    gemeinde: 'Mödling',
    postcode: '2340',
    kind: 'address',
  },
  {
    label: 'Hauptstraße 41, 8010 Graz',
    lat: 47.0707,
    lon: 15.4395,
    country: 'at',
    bundesland: 'steiermark',
    state: 'Steiermark',
    gemeinde: 'Graz',
    postcode: '8010',
    kind: 'address',
  },
]

const geocoder: GeocodingClient = {
  search: async (q) => ({
    enabled: true,
    results: FIXTURE_RESULTS.filter((place) => place.label.toLowerCase().includes(q.trim().toLowerCase().slice(0, 4))),
  }),
}

const sameAddress: SameAddressClient = {
  find: async (place) => ({
    projects:
      place.label === FIXTURE_RESULTS[0].label
        ? [
            { id: 'preview-1', name: 'Wohnhaus Hauptstraße 12', status: 'closed' },
            { id: 'preview-2', name: 'Dachausbau Hauptstraße 12', status: 'active' },
          ]
        : [],
  }),
}

export default function CreateProjectPreviewPage() {
  return (
    <main className="min-h-dvh bg-background px-4 py-10" data-testid="create-project-preview">
      <h1 className="mx-auto mb-6 max-w-lg font-mono text-xs text-muted-foreground">/dev/create-project</h1>
      <CreateProjectDialog defaultOpen addressClients={{ client: geocoder, sameAddressClient: sameAddress }} />
    </main>
  )
}
