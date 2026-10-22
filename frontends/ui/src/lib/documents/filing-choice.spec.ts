import { describe, expect, it } from 'vitest'
import { FILING_CHOICE_METADATA_KEY, filingChoiceRecord, storedFilingChoice } from './filing-choice'
import { DOCUMENT_TYPE_TAGS } from './tag-vocabulary'

const TYPE = DOCUMENT_TYPE_TAGS[0]
const row = (metadata: unknown, contentHash: string | null = 'sha256:abc') => ({ metadata, contentHash })

describe('filingChoiceRecord', () => {
  it('records only what was chosen, and nothing when nothing was', () => {
    expect(filingChoiceRecord({ documentType: TYPE, revisionOf: 'Index_B.pdf' })).toEqual({
      documentType: TYPE,
      revisionOf: 'Index_B.pdf',
    })
    expect(filingChoiceRecord({ documentType: TYPE, revisionOf: null })).toEqual({ documentType: TYPE })
    expect(filingChoiceRecord({ documentType: null, revisionOf: null })).toBeNull()
    expect(filingChoiceRecord({})).toBeNull()
  })
})

describe('storedFilingChoice', () => {
  const recorded = (choice: unknown, ingestContentHash = 'sha256:abc') => ({
    ingestJobId: 'job-1',
    ingestContentHash,
    [FILING_CHOICE_METADATA_KEY]: choice,
  })

  it('reads back what the dispatch of these bytes recorded', () => {
    expect(storedFilingChoice(row(recorded({ documentType: TYPE, revisionOf: 'Index_B.pdf' })))).toEqual({
      documentType: TYPE,
      revisionOf: 'Index_B.pdf',
    })
    expect(storedFilingChoice(row(recorded({ revisionOf: 'Index_B.pdf' })))).toEqual({
      documentType: null,
      revisionOf: 'Index_B.pdf',
    })
  })

  it('reads nothing for other bytes than the row holds, or a row with no digest', () => {
    expect(storedFilingChoice(row(recorded({ documentType: TYPE }, 'sha256:older')))).toBeNull()
    expect(storedFilingChoice(row(recorded({ documentType: TYPE }), null))).toBeNull()
  })

  it('reads nothing from a row with no choice, or metadata of another shape', () => {
    expect(storedFilingChoice(row({ ingestJobId: 'job-1', ingestContentHash: 'sha256:abc' }))).toBeNull()
    expect(storedFilingChoice(row(null))).toBeNull()
    expect(storedFilingChoice(row([TYPE]))).toBeNull()
    expect(storedFilingChoice(row(recorded('Grundriss')))).toBeNull()
  })

  it('drops a type outside the vocabulary and a name no file can have', () => {
    expect(storedFilingChoice(row(recorded({ documentType: 'retired-type' })))).toBeNull()
    expect(storedFilingChoice(row(recorded({ documentType: 'retired-type', revisionOf: 'Index_B.pdf' })))).toEqual({
      documentType: null,
      revisionOf: 'Index_B.pdf',
    })
    expect(storedFilingChoice(row(recorded({ revisionOf: 'x'.repeat(256) })))).toBeNull()
    expect(storedFilingChoice(row(recorded({ revisionOf: '   ' })))).toBeNull()
  })
})
