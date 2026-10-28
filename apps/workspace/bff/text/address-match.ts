/**
 * Whether two address lines name the same place, and how far apart two points
 * are. Shared by the „An dieser Adresse gibt es schon ein Projekt" lookup; a
 * second caller (the intake's own address check) should reuse them.
 */

import { foldDiacritics } from './latinize'

/**
 * An address line as comparable text: case, diacritics, punctuation and
 * spacing folded away, so „Hauptstraße 12, 1010 Wien" and „hauptstrasse 12
 * 1010  wien" are one address. The ß is `ss` first, because folding alone
 * drops it.
 */
export function normalizeAddress(value: string): string {
  return foldDiacritics(value.replace(/ß/g, 'ss').toLowerCase())
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

const EARTH_RADIUS_M = 6_371_000

/** Great-circle distance between two WGS84 points, in metres (haversine). */
export function distanceMetres(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const rad = (degrees: number): number => (degrees * Math.PI) / 180
  const dLat = rad(b.lat - a.lat)
  const dLon = rad(b.lon - a.lon)
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)))
}
