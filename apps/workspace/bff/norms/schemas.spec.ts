/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'

import {
  normEntrySchema,
  normsFileSchema,
  putNormRegistryBodySchema,
  verifyNormResponseSchema,
} from './schemas'

const validEntry = {
  id: 'oib-rl2-2023',
  title: 'OIB-Richtlinie 2 — Brandschutz (Ausgabe 2023)',
  short: 'OIB-RL 2',
  rank: 'ordinance',
  federal_state: 'Wien',
  topics: ['Brandschutz', 'Fluchtwege'],
  relevance: 'hoch',
  application: 'LrKons',
  document_number: 'NOR40251234',
  citation_url: 'https://ris.example/cite',
  full_law_url: 'https://ris.example/full',
  aliases: ['Richtlinie 2'],
  binding_note: 'Verbindlich in Wien.',
  review_note: 'Neuauflage 2024 prüfen.',
  verify: { title_query: 'OIB Richtlinie 2', exclude: ['Salzburg'], statute_number: '20000123' },
  verified_at: '2026-01-15',
}

describe('normEntrySchema', () => {
  it('parses a fully-populated valid entry', () => {
    const parsed = normEntrySchema.parse(validEntry)
    expect(parsed.id).toBe('oib-rl2-2023')
    expect(parsed.rank).toBe('ordinance')
    expect(parsed.topics).toEqual(['Brandschutz', 'Fluchtwege'])
    expect(parsed.verify?.exclude).toEqual(['Salzburg'])
  })

  it('applies defaults for a minimal entry (federal, unverified)', () => {
    const parsed = normEntrySchema.parse({
      id: 'bo-wien',
      title: 'Bauordnung',
      short: 'BO',
      rank: 'state_law',
    })
    expect(parsed.federal_state).toBe('')
    expect(parsed.topics).toEqual([])
    expect(parsed.aliases).toEqual([])
    expect(parsed.verified_at).toBe('')
    expect(parsed.verify).toBeUndefined()
    expect(parsed.binding_note).toBeUndefined()
  })

  it('parses an authority_info entry with only a source_url (no RIS pointer)', () => {
    const parsed = normEntrySchema.parse({
      id: 'ma37-merkblatt-stellplatz',
      title: 'MA 37 — Merkblatt Stellplatzverpflichtung',
      short: 'MA 37 Stellplatz',
      rank: 'authority_info',
      source_url: 'https://www.wien.gv.at/stadtentwicklung/ma37/merkblatt.pdf',
    })
    expect(parsed.rank).toBe('authority_info')
    expect(parsed.source_url).toBe('https://www.wien.gv.at/stadtentwicklung/ma37/merkblatt.pdf')
    expect(parsed.application).toBe('')
    expect(parsed.document_number).toBe('')
  })

  it('parses an external_standard entry with no pointer at all', () => {
    const parsed = normEntrySchema.parse({
      id: 'oenorm-b-1300',
      title: 'ÖNORM B 1300',
      short: 'ÖNORM B 1300',
      rank: 'external_standard',
    })
    expect(parsed.rank).toBe('external_standard')
    expect(parsed.application).toBe('')
    expect(parsed.document_number).toBe('')
    expect(parsed.source_url).toBe('')
  })

  it('reads the German ranks a stored registry still carries', () => {
    expect(normEntrySchema.parse({ ...validEntry, rank: 'landesgesetz' }).rank).toBe('state_law')
    expect(normEntrySchema.parse({ ...validEntry, rank: 'behoerdliche_info' }).rank).toBe('authority_info')
    expect(normEntrySchema.parse({ ...validEntry, rank: 'norm_extern' }).rank).toBe('external_standard')
  })

  it('rejects an invalid rank', () => {
    const result = normEntrySchema.safeParse({ ...validEntry, rank: 'richtlinie' })
    expect(result.success).toBe(false)
  })

  it('rejects a missing id', () => {
    const { id: _omit, ...withoutId } = validEntry
    expect(normEntrySchema.safeParse(withoutId).success).toBe(false)
  })

  it('rejects an empty id', () => {
    expect(normEntrySchema.safeParse({ ...validEntry, id: '' }).success).toBe(false)
  })
})

describe('normsFileSchema', () => {
  it('requires the file-format version literal 1', () => {
    expect(normsFileSchema.safeParse({ version: 2, entries: [] }).success).toBe(false)
    expect(normsFileSchema.safeParse({ version: 1, entries: [validEntry] }).success).toBe(true)
  })

  it('defaults the CountryProfile override fields when absent', () => {
    const parsed = normsFileSchema.parse({ version: 1, entries: [] })
    expect(parsed.corpus_collection).toBe('oib_knowledge')
    expect(parsed.language).toBe('')
    expect(parsed.states).toEqual({})
    expect(parsed.corpus_note).toBe('')
    expect(parsed.doctrine).toBe('')
    expect(parsed.parcel_tags).toEqual([])
  })

  it('round-trips the CountryProfile override fields verbatim', () => {
    const input = {
      version: 1 as const,
      corpus_collection: 'de_knowledge',
      language: 'de-DE',
      states: { bayern: 'Bayern', ausserhalb: null },
      corpus_note: 'Korpus-Hinweis',
      doctrine: 'Custom doctrine',
      parcel_tags: ['Bebauungsplan'],
      entries: [validEntry],
    }
    const parsed = normsFileSchema.parse(input)
    expect(parsed.corpus_collection).toBe('de_knowledge')
    expect(parsed.language).toBe('de-DE')
    expect(parsed.states).toEqual({ bayern: 'Bayern', ausserhalb: null })
    expect(parsed.corpus_note).toBe('Korpus-Hinweis')
    expect(parsed.doctrine).toBe('Custom doctrine')
    expect(parsed.parcel_tags).toEqual(['Bebauungsplan'])
  })
})

describe('putNormRegistryBodySchema', () => {
  it('accepts the concurrency-version envelope', () => {
    const parsed = putNormRegistryBodySchema.parse({
      version: 7,
      registry: { version: 1, entries: [validEntry] },
    })
    expect(parsed.version).toBe(7)
    expect(parsed.registry.entries).toHaveLength(1)
  })
})

describe('verifyNormResponseSchema', () => {
  it('parses candidates and verified_at', () => {
    const parsed = verifyNormResponseSchema.parse({
      candidates: [
        { title: 'OIB-RL 2', document_number: 'NOR1', citation_url: 'https://a', full_law_url: 'https://b' },
      ],
      verified_at: '2026-07-18',
    })
    expect(parsed.candidates[0].document_number).toBe('NOR1')
    expect(parsed.verified_at).toBe('2026-07-18')
  })
})

describe('backend null contract (regression: Register konnte nicht geladen werden)', () => {
  it('parses an entry whose verify seed is null (pydantic VerifySeed | None)', () => {
    // The backend serializes a seedless entry as `verify: null`; `.optional()`
    // alone would reject it and fail the whole registry load.
    const parsed = normEntrySchema.parse({
      id: 'ma37-merkblaetter',
      title: 'MA 37 Merkblätter',
      short: 'MA 37',
      rank: 'authority_info',
      federal_state: 'Wien',
      source_url: 'https://www.wien.gv.at/x',
      binding_note: null,
      review_note: null,
      verify: null,
    })
    expect(parsed.verify).toBeNull()
    expect(parsed.id).toBe('ma37-merkblaetter')
  })

  it('parses the full GET envelope shape with a null-verify entry present', () => {
    const envelope = {
      version: 1,
      registry: {
        version: 1,
        corpus_collection: 'oib_knowledge',
        language: '',
        states: { wien: 'Wien', ausserhalb_oesterreichs: null },
        corpus_note: '',
        doctrine: '',
        parcel_tags: [],
        entries: [
          validEntry,
          { id: 'ma37', title: 'MA 37', short: 'MA 37', rank: 'authority_info', verify: null },
        ],
      },
    }
    const parsed = putNormRegistryBodySchema.parse(envelope)
    expect(parsed.registry.entries).toHaveLength(2)
    expect(parsed.registry.states.outside_austria).toBeNull()
  })
})

describe('a registry stored before the English names', () => {
  it('reads `bundesland` as `federal_state` and the German tokens of `states` as English ones', () => {
    const parsed = putNormRegistryBodySchema.parse({
      version: 1,
      registry: {
        version: 1,
        states: { wien: 'Wien', ausserhalb_oesterreichs: null },
        entries: [{ id: 'bo-wien', title: 'Bauordnung für Wien', short: 'BO', rank: 'state_law', bundesland: 'Wien' }],
      },
    })
    expect(parsed.registry.entries[0]).toMatchObject({ federal_state: 'Wien' })
    expect(parsed.registry.entries[0]).not.toHaveProperty('bundesland')
    expect(parsed.registry.states).toEqual({ vienna: 'Wien', outside_austria: null })
  })
})
