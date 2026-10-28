/**
 * @vitest-environment node
 */
import { describe, expect, it, vi } from 'vitest'

// The office's „Sensible Daten" policy (ADR-0086): here it masks one name and
// one IBAN, so a spec sees that a quote went through it.
vi.mock('@/lib/upload-screening/service', () => ({
  maskChatText: vi.fn(async (_org: string, text: string) => ({
    text: text.replaceAll('Maria Huber', '[Name]').replaceAll('AT611904300234573201', '[IBAN]'),
  })),
}))

import { maskChatText } from '@/lib/upload-screening/service'
import { documentEvidence, reasonFromEvidence } from './evidence'
import { documentEvidenceSchema, MAX_EVIDENCE_QUOTE_LENGTH } from './types'

const policy = { organizationId: 'org-1' }

describe('documentEvidence', () => {
  it("returns evidence the profile schema accepts, asking the organization's policy", async () => {
    const evidence = await documentEvidence(
      {
        fileName: 'Baubeschreibung.pdf',
        page: 4,
        quote: 'Es sind 3 oberirdische Geschoße vorgesehen.',
      },
      policy
    )

    expect(evidence).toEqual({
      kind: 'document',
      fileName: 'Baubeschreibung.pdf',
      page: 4,
      quote: 'Es sind 3 oberirdische Geschoße vorgesehen.',
    })
    expect(documentEvidenceSchema.safeParse(evidence).success).toBe(true)
    expect(maskChatText).toHaveBeenCalledWith(
      'org-1',
      'Es sind 3 oberirdische Geschoße vorgesehen.'
    )
  })

  it('masks the quote before it is stored', async () => {
    const evidence = await documentEvidence(
      {
        fileName: 'Bescheid.pdf',
        page: null,
        quote: 'Bauwerberin Maria Huber, Konto AT611904300234573201',
      },
      policy
    )

    expect(evidence.quote).toBe('Bauwerberin [Name], Konto [IBAN]')
    expect(evidence.page).toBeNull()
  })

  it('cuts a long quote to what the profile keeps, after masking', async () => {
    const long = `Maria Huber ${'x'.repeat(MAX_EVIDENCE_QUOTE_LENGTH * 2)}`

    const evidence = await documentEvidence(
      { fileName: 'Bescheid.pdf', page: 2, quote: long },
      policy
    )

    expect(evidence.quote).toHaveLength(MAX_EVIDENCE_QUOTE_LENGTH)
    expect(evidence.quote.startsWith('[Name] x')).toBe(true)
    expect(evidence.quote.endsWith('…')).toBe(true)
    expect(documentEvidenceSchema.safeParse(evidence).success).toBe(true)
  })
})

describe('reasonFromEvidence', () => {
  it('words the reason as file, page and quote', () => {
    expect(
      reasonFromEvidence({ fileName: 'Baubeschreibung.pdf', page: 3, quote: 'Gebäudeklasse 4' })
    ).toBe('Baubeschreibung.pdf, S. 3: „Gebäudeklasse 4"')
  })

  it('leaves the page out when the document has none', () => {
    expect(reasonFromEvidence({ fileName: 'Raumbuch.xlsx', page: null, quote: 'BGF 412 m²' })).toBe(
      'Raumbuch.xlsx: „BGF 412 m²"'
    )
  })
})
