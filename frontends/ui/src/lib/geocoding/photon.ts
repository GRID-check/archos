/**
 * Photon (OSM, komoot) as the address search adapter.
 *
 * `parsePhotonResponse` is pure: a Photon FeatureCollection in, Austrian
 * `GeocodeResult`s out. `searchPhoton` is the one network call and never
 * throws; a failed search is an empty one, logged.
 *
 * Austria only (product decision). Photon is asked for the Austrian bounding
 * box and every hit is checked against `countrycode` anyway, because the box
 * also covers parts of the neighbouring countries. A second country is a new
 * filter and a new state mapping, nothing more.
 */

import { z } from 'zod'
import { findIntakeQuestion, projectIntakeDefinitionV1 } from '@/lib/project-profile/intake-definition'
import { foldDiacritics, latinize } from '@/lib/text/latinize'
import { GEOCODE_DEFAULT_LIMIT, GEOCODE_MAX_LIMIT, type GeocodeKind, type GeocodeResult } from './types'

/** minLon,minLat,maxLon,maxLat: Austria, a little generous. */
const AUSTRIA_BBOX = '9.53,46.37,17.16,49.02'

/** Photon answers in well under a second; an autocomplete that waits longer is useless. */
const PHOTON_TIMEOUT_MS = 4_000

/** A proxy in front of a self-hosted Photon may redirect (http to https, a trailing slash). */
const MAX_REDIRECTS = 2

/**
 * `A2_land` options that name a Land, read off the wizard's own question so
 * the mapping cannot drift from it. The "outside Austria" option is no Land.
 */
const LAND_OPTIONS: ReadonlyArray<{ token: string; keys: string[] }> = (
  findIntakeQuestion(projectIntakeDefinitionV1, 'A2_land')?.options ?? []
)
  .filter((option) => option.value !== 'ausserhalb_oesterreichs')
  .map((option) => ({ token: option.value, keys: [...matchKeys(option.label), option.value] }))

/**
 * Case- and diacritic-insensitive: "Kärnten", "Kaernten" and "Karnten" are
 * one Land. Two spellings, because `ä` folds to `a` and spells out to `ae`.
 */
function matchKeys(value: string): string[] {
  const squash = (spelled: string) => spelled.toLowerCase().replace(/\s+/g, ' ').trim()
  return [squash(latinize(value)), squash(foldDiacritics(value))]
}

/** The intake token for a state label, or null. */
function federalStateToken(state: string | null): string | null {
  if (!state) return null
  const keys = matchKeys(state)
  return LAND_OPTIONS.find((option) => option.keys.some((key) => keys.includes(key)))?.token ?? null
}

const text = z.string().trim().min(1).optional().catch(undefined)

/** Lenient on purpose: one odd feature must not cost the person the other suggestions. */
const featureSchema = z.object({
  properties: z.object({
    type: text,
    name: text,
    street: text,
    housenumber: text,
    city: text,
    state: text,
    postcode: text,
    countrycode: text,
  }),
  geometry: z.object({
    coordinates: z.tuple([z.number(), z.number()]).rest(z.number()),
  }),
})

const collectionSchema = z.object({ features: z.array(z.unknown()) })

type Properties = z.infer<typeof featureSchema>['properties']

function kindOf(properties: Properties): GeocodeKind {
  if (properties.housenumber) return 'address'
  return properties.type === 'street' ? 'street' : 'place'
}

/** The Gemeinde: Photon's `city`, or the hit itself when it is the town ("type": "city"). */
function municipalityOf(properties: Properties): string | null {
  if (properties.city) return properties.city
  return properties.type === 'city' ? (properties.name ?? null) : null
}

/** "Straße Nr, PLZ Ort". A town hit is just "PLZ Ort": its name is the Ort. */
function labelOf(properties: Properties, municipality: string | null): string | null {
  const place = [properties.postcode, municipality].filter(Boolean).join(' ')
  const firstLine = properties.housenumber
    ? [properties.street ?? properties.name, properties.housenumber].filter(Boolean).join(' ')
    : properties.type === 'city' && municipality === properties.name
      ? undefined
      : (properties.name ?? properties.street)
  const label = [firstLine, place].filter(Boolean).join(', ')
  return label || null
}

function toResult(raw: unknown): GeocodeResult | null {
  const feature = featureSchema.safeParse(raw)
  if (!feature.success) return null
  const { properties, geometry } = feature.data
  if (properties.countrycode?.toUpperCase() !== 'AT') return null

  const [lon, lat] = geometry.coordinates
  const municipality = municipalityOf(properties)
  const label = labelOf(properties, municipality)
  if (!label || !(Math.abs(lat) <= 90) || !(Math.abs(lon) <= 180)) return null

  // Vienna is a city-state: Photon names no state for it, only the city.
  const federalState =
    federalStateToken(properties.state ?? null) ?? (municipality && federalStateToken(municipality) === 'wien' ? 'wien' : null)
  const state = properties.state ?? (federalState === 'wien' ? 'Wien' : null)

  return {
    label,
    lat,
    lon,
    country: 'at',
    bundesland: federalState,
    state,
    gemeinde: municipality,
    postcode: properties.postcode ?? null,
    kind: kindOf(properties),
  }
}

/** Austrian hits of a Photon response, one per label, in the provider's order. Malformed input gives `[]`. */
export function parsePhotonResponse(json: unknown): GeocodeResult[] {
  const collection = collectionSchema.safeParse(json)
  if (!collection.success) return []
  const seen = new Set<string>()
  const results: GeocodeResult[] = []
  for (const raw of collection.data.features) {
    const result = toResult(raw)
    if (!result || seen.has(result.label)) continue
    seen.add(result.label)
    results.push(result)
  }
  return results
}

export interface PhotonSearchOptions {
  limit?: number
  signal?: AbortSignal
  /** Replaces `fetch`; the specs' seam. */
  fetchImpl?: typeof fetch
}

function photonUrl(baseUrl: string, query: string, limit: number): URL {
  const url = new URL('api/', baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`)
  url.searchParams.set('q', query)
  // Hits collapse (one street, many POIs) and the box spills over the border,
  // so ask for more than the caller wants and cut afterwards.
  url.searchParams.set('limit', String(Math.min(limit * 2, GEOCODE_MAX_LIMIT * 2)))
  url.searchParams.set('lang', 'de')
  url.searchParams.set('bbox', AUSTRIA_BBOX)
  return url
}

/** GET with redirects followed only within the configured origin: a query is client data. */
async function fetchSameOrigin(url: URL, signal: AbortSignal, fetchImpl: typeof fetch): Promise<Response> {
  let target = url
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const response = await fetchImpl(target, {
      headers: { accept: 'application/json' },
      redirect: 'manual',
      signal,
    })
    const location = response.headers.get('location')
    if (response.status < 300 || response.status >= 400 || !location) return response
    const next = new URL(location, target)
    if (next.origin !== url.origin) throw new Error(`redirect to another origin refused (${next.origin})`)
    target = next
  }
  throw new Error('too many redirects')
}

/**
 * Search Photon at `baseUrl`. Never throws: any failure (timeout, refusal,
 * bad JSON, a redirect off the host) is logged and answers `[]`, so the
 * dialog falls back to choosing the federal state by hand.
 */
export async function searchPhoton(
  baseUrl: string,
  query: string,
  options: PhotonSearchOptions = {},
): Promise<GeocodeResult[]> {
  const limit = options.limit ?? GEOCODE_DEFAULT_LIMIT
  const timeout = AbortSignal.timeout(PHOTON_TIMEOUT_MS)
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout
  try {
    const response = await fetchSameOrigin(photonUrl(baseUrl, query, limit), signal, options.fetchImpl ?? fetch)
    if (!response.ok) {
      console.error(`[geocode] photon answered ${response.status}`)
      return []
    }
    return parsePhotonResponse(await response.json()).slice(0, limit)
  } catch (error) {
    console.error('[geocode] photon search failed', error instanceof Error ? error.message : error)
    return []
  }
}
