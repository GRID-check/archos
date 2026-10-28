/**
 * Photon responses captured from photon.komoot.io (2026-10-14), shared by the
 * parser, service and route specs. Each is trimmed only by `limit`.
 */

const collection = (...features: unknown[]) => ({ type: 'FeatureCollection', features })

/** `q=Mariahilfer Straße 10 Wien&limit=2&lang=de`: a POI with no house number, then a street. Vienna has no `state`. */
export const PHOTON_MARIAHILFER = collection(
  {
    type: 'Feature',
    properties: {
      osm_type: 'N', osm_id: 4123615290, osm_key: 'railway', osm_value: 'station', type: 'house',
      name: 'Museumsquartier', street: 'Museumsplatz', locality: 'Spittelberg',
      district: 'Katastralgemeinde Neubau', city: 'Wien', country: 'Österreich', postcode: '1070', countrycode: 'AT',
    },
    geometry: { type: 'Point', coordinates: [16.3612175, 48.2027122] },
  },
  {
    type: 'Feature',
    properties: {
      osm_type: 'W', osm_id: 10125314, osm_key: 'highway', osm_value: 'residential', type: 'street',
      name: 'Mariahilfer Straße', locality: 'Obere Windmühle', district: 'Katastralgemeinde Mariahilf',
      city: 'Wien', country: 'Österreich', postcode: '1060', countrycode: 'AT',
      extent: [16.3409637, 48.1962283, 16.3416147, 48.1961098],
    },
    geometry: { type: 'Point', coordinates: [16.3412897, 48.1961665] },
  },
)

/** `q=Mödling&limit=1&lang=de&layer=city`: a town, which carries `state` but no `city`. */
export const PHOTON_MOEDLING = collection({
  type: 'Feature',
  properties: {
    osm_type: 'R', osm_id: 152072, osm_key: 'place', osm_value: 'town', type: 'city', name: 'Mödling',
    county: 'Bezirk Mödling', state: 'Niederösterreich', country: 'Österreich', postcode: '2340', countrycode: 'AT',
    extra: { admin_level: '8' },
  },
  geometry: { type: 'Point', coordinates: [16.2833526, 48.0855922] },
})

/** `q=Graben 20 Wien&limit=3&lang=de`: house numbers. The second and third share a label with nobody. */
export const PHOTON_GRABEN = collection(
  {
    type: 'Feature',
    properties: {
      osm_type: 'N', osm_id: 245485017, osm_key: 'shop', osm_value: 'clothes', type: 'house', housenumber: '20',
      name: 'Louis Vuitton', street: 'Graben', locality: 'Widmerviertel', district: 'Innere Stadt', city: 'Wien',
      country: 'Österreich', postcode: '1010', countrycode: 'AT',
    },
    geometry: { type: 'Point', coordinates: [16.3684666, 48.2095424] },
  },
  {
    type: 'Feature',
    properties: {
      osm_type: 'N', osm_id: 566660686, osm_key: 'place', osm_value: 'house', type: 'house', housenumber: '20',
      street: 'Tiefer Graben', locality: 'Schottenviertel', district: 'Innere Stadt', city: 'Wien',
      country: 'Österreich', postcode: '1010', countrycode: 'AT',
    },
    geometry: { type: 'Point', coordinates: [16.3683609, 48.2124224] },
  },
)

/** `q=Hauptstraße 1 Innsbruck&limit=3&lang=de`: house numbers outside Vienna; the Tirol state label. */
export const PHOTON_HAUPTSTRASSE = collection(
  {
    type: 'Feature',
    properties: {
      osm_type: 'W', osm_id: 185781834, osm_key: 'building', osm_value: 'yes', type: 'house', housenumber: '1',
      street: 'Hauptstraße', district: 'Unterschindeltal', city: 'Inzing', county: 'Bezirk Innsbruck-Land',
      state: 'Tirol', country: 'Österreich', postcode: '6401', countrycode: 'AT',
    },
    geometry: { type: 'Point', coordinates: [11.1972888, 47.2740756] },
  },
  {
    type: 'Feature',
    properties: {
      osm_type: 'W', osm_id: 85040419, osm_key: 'building', osm_value: 'yes', type: 'house', housenumber: '1d',
      street: 'Hauptstraße', district: 'Triendlsiedlung', city: 'Rinn', county: 'Bezirk Innsbruck-Land',
      state: 'Tirol', country: 'Österreich', postcode: '6074', countrycode: 'AT',
    },
    geometry: { type: 'Point', coordinates: [11.4988801, 47.2495229] },
  },
)

/** `q=Marienplatz 1 München&limit=1&lang=de`: a German hit. Piloti is Austria only, so it is dropped. */
export const PHOTON_MARIENPLATZ_MUENCHEN = collection({
  type: 'Feature',
  properties: {
    osm_type: 'N', osm_id: 11862335250, osm_key: 'place', osm_value: 'house', type: 'house', housenumber: '1',
    street: 'Marienplatz', locality: 'Kreuzviertel', district: 'Altstadt', city: 'München', state: 'Bayern',
    country: 'Deutschland', postcode: '80331', countrycode: 'DE',
  },
  geometry: { type: 'Point', coordinates: [11.5747253, 48.1376095] },
})

/** `q=Berlin&limit=3&lang=de`, abridged: Germany, then the United States. */
export const PHOTON_BERLIN = collection(
  {
    type: 'Feature',
    properties: {
      osm_type: 'R', osm_id: 62422, osm_key: 'place', osm_value: 'city', type: 'city', name: 'Berlin',
      country: 'Deutschland', countrycode: 'DE', extra: { admin_level: '4' },
    },
    geometry: { type: 'Point', coordinates: [13.3951309, 52.5173885] },
  },
  {
    type: 'Feature',
    properties: {
      osm_type: 'R', osm_id: 170184, osm_key: 'place', osm_value: 'city', type: 'city', name: 'Berlin',
      county: 'Coos', state: 'New Hampshire', country: 'Vereinigte Staaten von Amerika', postcode: '03570',
      countrycode: 'US',
    },
    geometry: { type: 'Point', coordinates: [-71.1810703, 44.4696602] },
  },
)
