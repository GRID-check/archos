import { render, screen } from '@/test-utils'
import { describe, expect, it } from 'vitest'
import { filesCopy } from '@/i18n/namespaces/files'
import type { QuarantineVerdict } from '@/lib/upload-screening/quarantine'
import { QuarantineFindings } from './quarantine-findings'

const verdict: QuarantineVerdict = {
  reasons: [
    { kind: 'term', term: 'Lohnzettel', count: 2, pages: [1, 3] },
    { kind: 'iban', count: 1, pages: [], sample: 'AT61 •••• •••• •••• 3201' },
  ],
}

describe('QuarantineFindings', () => {
  it('says as text how the check came to each kind of reason, once per kind', () => {
    const twoTerms: QuarantineVerdict = {
      reasons: [{ kind: 'term', term: 'Honorar', count: 1, pages: [2] }, ...verdict.reasons],
    }
    render(<QuarantineFindings verdict={twoTerms} />)
    // Not a tooltip: a chip is no focus target and a touch has no hover.
    expect(screen.getAllByTestId('quarantine-findings-basis').map((line) => line.textContent)).toEqual([
      filesCopy.messages.en.screening.basisTerm,
      filesCopy.messages.en.screening.basisIban,
    ])
  })

  it('says a reason without a page has none, instead of leaving the reader to look for it', () => {
    render(<QuarantineFindings verdict={verdict} />)
    expect(screen.getByText(/no page given/)).toBeInTheDocument()
  })

  it('never shows a short list as the whole one', () => {
    render(<QuarantineFindings verdict={{ ...verdict, omitted: 3 }} />)
    expect(screen.getByTestId('quarantine-findings-omitted')).toHaveTextContent('3 more reasons are not listed.')
  })

  it('claims nothing about the content when the reason cannot be read', () => {
    render(<QuarantineFindings verdict={null} />)
    expect(screen.getByText(filesCopy.messages.en.ingestFailure.quarantinedUnreadable)).toBeInTheDocument()
    expect(screen.queryByText(filesCopy.messages.en.ingestFailure.quarantined)).toBeNull()
  })

  it('does not call a verdict unreadable when it only left its reasons out', () => {
    render(<QuarantineFindings verdict={{ reasons: [], omitted: 2 }} />)
    expect(screen.getByText(filesCopy.messages.en.ingestFailure.quarantined)).toBeInTheDocument()
  })

  it('does not claim no model saw a file caught in its scanned pages\' transcript', () => {
    render(<QuarantineFindings verdict={{ ...verdict, checked: 'partial', after_transcription: true }} />)
    expect(screen.getByTestId('quarantine-findings-sentence')).toHaveTextContent(
      filesCopy.messages.en.ingestFailure.quarantinedAfterTranscription
    )
    expect(screen.queryByText(filesCopy.messages.en.ingestFailure.quarantined)).toBeNull()
  })

  it('gives the explaining sentence when reasons are listed', () => {
    render(<QuarantineFindings verdict={verdict} />)
    expect(screen.getByText(filesCopy.messages.en.ingestFailure.quarantined)).toBeInTheDocument()
  })
})
