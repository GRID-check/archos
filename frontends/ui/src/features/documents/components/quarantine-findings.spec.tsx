import { render, screen } from '@/test-utils'
import { describe, expect, it } from 'vitest'
import { en } from '@/i18n/dictionaries/en'
import type { QuarantineVerdict } from '@/lib/upload-screening/quarantine'
import { QuarantineFindings } from './quarantine-findings'

const verdict: QuarantineVerdict = {
  reasons: [
    { kind: 'term', term: 'Lohnzettel', count: 2, pages: [1, 3] },
    { kind: 'iban', count: 1, pages: [], sample: 'AT61 •••• •••• •••• 3201' },
  ],
}

describe('QuarantineFindings', () => {
  it('says under each reason how the check came to it, where the surface has room', () => {
    render(<QuarantineFindings verdict={verdict} explain />)
    expect(screen.getAllByTestId('quarantine-findings-basis').map((line) => line.textContent)).toEqual([
      en.files.screening.basisTerm,
      en.files.screening.basisIban,
    ])
  })

  it('leaves it to the chip tooltip elsewhere', () => {
    render(<QuarantineFindings verdict={verdict} />)
    expect(screen.queryByTestId('quarantine-findings-basis')).toBeNull()
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
    render(<QuarantineFindings errorMessage="quarantined:{broken" />)
    expect(screen.getByText(en.files.ingestFailure.quarantinedUnreadable)).toBeInTheDocument()
    expect(screen.queryByText(en.files.ingestFailure.quarantined)).toBeNull()
  })

  it('gives the explaining sentence when reasons are listed', () => {
    render(<QuarantineFindings verdict={verdict} />)
    expect(screen.getByText(en.files.ingestFailure.quarantined)).toBeInTheDocument()
  })
})
