'use client'

/**
 * The create-project dialog, shown open, so its anatomy is screenshot-
 * reviewable without a database. Submitting calls the real server action and
 * fails without one; the dialog shows its calm error then.
 *
 * The address search and the same-address lookup answer from fixtures here:
 * type „Haupt" or „Lack" for suggestions; the first Hauptstraße has an earlier
 * project. `?filled=1` opens it filled in, the description unfolded.
 */

import { use } from 'react'
import { CreateProjectDialog } from '@/components/projects/create-project-dialog'
import type { GeocodingClient } from '@/lib/geocoding/client'
import type { GeocodeResult } from '@/lib/geocoding/types'
import type { SameAddressClient } from '@/lib/projects/same-address-client'

const FIXTURE_RESULTS: GeocodeResult[] = [
  {
    label: 'Lacknergasse 12, 1170 Wien',
    lat: 48.2236,
    lon: 16.3302,
    country: 'at',
    bundesland: 'wien',
    state: 'Wien',
    gemeinde: 'Hernals',
    postcode: '1170',
    kind: 'address',
  },
  {
    label: 'Lacknergasse 12, 2340 Mödling',
    lat: 48.0861,
    lon: 16.2834,
    country: 'at',
    bundesland: 'niederoesterreich',
    state: 'Niederösterreich',
    gemeinde: 'Mödling',
    postcode: '2340',
    kind: 'address',
  },
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
      place.label === FIXTURE_RESULTS[2].label
        ? [
            { id: 'preview-1', name: 'Wohnhaus Hauptstraße 12', status: 'closed' },
            { id: 'preview-2', name: 'Dachausbau Hauptstraße 12', status: 'active' },
          ]
        : [],
  }),
}

const FILLED = {
  name: 'Aufstockung Lacknergasse',
  address: 'Lacknergasse 12',
  description: 'Aufstockung eines Gründerzeithauses um zwei Geschoße, Dachgeschoßausbau mit 6 Wohnungen.',
}

export default function CreateProjectPreviewPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const filled = use(searchParams).filled === '1'
  return (
    <main className="min-h-dvh bg-background px-4 py-10" data-testid="create-project-preview">
      <h1 className="mx-auto mb-6 max-w-lg font-mono text-xs text-muted-foreground">/dev/create-project</h1>
      <CreateProjectDialog
        defaultOpen
        addressClients={{ client: geocoder, sameAddressClient: sameAddress }}
        initial={filled ? FILLED : undefined}
      />
    </main>
  )
}
