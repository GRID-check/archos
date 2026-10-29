import { render, screen } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { describe, test, expect } from 'vitest'
import { ConfidenceChip } from './ConfidenceChip'
import { PRODUCT_NAME } from '@/lib/brand'

/**
 * ConfidenceChip surfaces the model's self-assessment and — when the backend
 * capped that confidence — explains WHY in the tooltip (PB-9). These specs
 * cover the reason→copy mapping and the fail-open generic behaviour.
 */
describe('ConfidenceChip', () => {
  test('renders nothing when confidence is absent', () => {
    const { container } = render(<ConfidenceChip confidence={undefined} />)
    expect(container).toBeEmptyDOMElement()
  })

  test('renders the chip label for a self-assessed level', () => {
    render(<ConfidenceChip confidence="low" />)
    expect(screen.getByText('Confidence: low')).toBeInTheDocument()
  })

  test('shows the ungrounded reason in the tooltip when capped for grounding', async () => {
    const user = userEvent.setup()
    render(<ConfidenceChip confidence="low" cappedReason="ungrounded" />)

    await user.hover(screen.getByRole('button'))

    expect(
      (await screen.findAllByText(/Low confidence: answer not backed by sources\./)).length
    ).toBeGreaterThan(0)
  })

  test('shows the quote-unverified reason in the tooltip when a quote could not be verified', async () => {
    const user = userEvent.setup()
    // A grounded answer with one unverified quote is held at "medium", so the
    // reason no longer names a level; it says what was capped and why.
    render(<ConfidenceChip confidence="medium" cappedReason="quote_unverified" />)

    await user.hover(screen.getByRole('button'))

    expect(
      (
        await screen.findAllByText(
          /A quote could not be verified verbatim against the source; the assessment is capped accordingly\./
        )
      ).length
    ).toBeGreaterThan(0)
  })

  test("labels the model's reason as the one it gave before the cap", async () => {
    const user = userEvent.setup()
    // The model explained a "high"; the backend held the answer at "medium".
    // Showing that explanation under the shown level would read as nonsense,
    // so the label says which level the reason belongs to.
    render(
      <ConfidenceChip
        confidence="medium"
        cappedReason="quote_unverified"
        reason="Every claim is backed by the cited paragraph."
      />
    )

    await user.hover(screen.getByRole('button'))

    expect((await screen.findAllByText(/Assistant's reason before the cap:/)).length).toBeGreaterThan(0)
    expect(screen.queryByText(/^Assistant's reason:$/)).not.toBeInTheDocument()
  })

  test("labels the model's reason plainly when nothing capped it", async () => {
    const user = userEvent.setup()
    render(<ConfidenceChip confidence="high" reason="Directly stated in the cited paragraph." />)

    await user.hover(screen.getByRole('button'))

    expect((await screen.findAllByText(/Assistant's reason:/)).length).toBeGreaterThan(0)
  })

  test('falls back to the generic tooltip when no reason is present', async () => {
    const user = userEvent.setup()
    render(<ConfidenceChip confidence="high" />)

    await user.hover(screen.getByRole('button'))

    // Generic self-assessment tooltip, with no capped-reason sentence appended.
    expect((await screen.findAllByText(/It can be wrong\./)).length).toBeGreaterThan(0)
    expect(screen.queryByText(/Low confidence:/)).not.toBeInTheDocument()
  })

  test('shows the level meaning in the tooltip', async () => {
    const user = userEvent.setup()
    render(<ConfidenceChip confidence="high" />)

    await user.hover(screen.getByRole('button'))

    expect((await screen.findAllByText(/directly grounded in the retrieved sources/)).length)
      .toBeGreaterThan(0)
  })

  test("shows the model's own reason verbatim in the tooltip when present", async () => {
    const user = userEvent.setup()
    render(<ConfidenceChip confidence="medium" reason="Keine Quelle zur Sonderregel" />)

    await user.hover(screen.getByRole('button'))

    expect((await screen.findAllByText(/Assistant's reason/)).length).toBeGreaterThan(0)
    expect((await screen.findAllByText(/Keine Quelle zur Sonderregel/)).length).toBeGreaterThan(0)
  })

  test('shows no reason block when reason is absent', async () => {
    const user = userEvent.setup()
    render(<ConfidenceChip confidence="medium" />)

    await user.hover(screen.getByRole('button'))

    expect((await screen.findAllByText(/It can be wrong\./)).length).toBeGreaterThan(0)
    expect(screen.queryByText(/Assistant's reason/)).not.toBeInTheDocument()
  })
})

/**
 * Rule 2 (ADR-0125): the level is held to the weakest sentence the answer rests
 * on, and the tooltip says what the sentences rest on. A turn stored before it
 * carries no version and keeps the copy it was computed under.
 */
describe('ConfidenceChip on a stored per-sentence turn (ADR-0125)', () => {
  test('keeps the copy of the rule it was stored under', async () => {
    const user = userEvent.setup()
    render(<ConfidenceChip confidence="low" cappedReason="normative_claim_uncited" version={2} />)

    await user.hover(screen.getByRole('button'))

    expect(
      (await screen.findAllByText(/A workspace record or a measurement does not back a legal statement\./)).length
    ).toBeGreaterThan(0)
    expect((await screen.findAllByText(/held to the weakest statement/)).length).toBeGreaterThan(0)
  })
})

describe('ConfidenceChip for a checked answer (ADR-0139)', () => {
  const finding = {
    statement: 'The stair is 1.50 m wide',
    problem: 'contradicted',
    reason: 'the section gives 1.10 m',
    source: '[1] Section A-A.pdf, p.2',
  } as const

  test('names what the check found unbacked, and the source it checked against', async () => {
    const user = userEvent.setup()
    render(
      <ConfidenceChip
        confidence="low"
        reason="Everything is backed."
        version={2}
        check={{ status: 'judged', level: 'low', findings: [finding] }}
      />
    )

    expect(screen.getByRole('button')).toHaveAccessibleName('Evidence check of the answer: low')
    await user.hover(screen.getByRole('button'))

    const findings = (await screen.findAllByTestId('confidence-check-findings'))[0]
    expect(findings).toHaveTextContent('The stair is 1.50 m wide')
    expect(findings).toHaveTextContent('contradicts the source: the section gives 1.10 m')
    expect(findings).toHaveTextContent('checked against [1] Section A-A.pdf, p.2')
    // The level is the check's, so the model's reason for its own self-report is not shown as if it were.
    expect(screen.queryByText(/Everything is backed\./)).not.toBeInTheDocument()
  })

  test('says when a quote the server could not find capped the level', async () => {
    const user = userEvent.setup()
    render(
      <ConfidenceChip
        confidence="medium"
        cappedReason="quote_unverified"
        check={{ status: 'judged', level: 'high', findings: [] }}
      />
    )

    await user.hover(screen.getByRole('button'))

    expect((await screen.findAllByText(/A quotation could not be confirmed word for word/)).length).toBeGreaterThan(0)
    expect(screen.queryByTestId('confidence-check-findings')).not.toBeInTheDocument()
  })

  test('an unavailable check shows no level and says the check did not run', async () => {
    const user = userEvent.setup()
    render(<ConfidenceChip confidence={null} check={{ status: 'unavailable', findings: [] }} />)

    expect(screen.getByTestId('confidence-check-unavailable')).toHaveTextContent('Evidence check unavailable')
    expect(screen.queryByText(/Confidence:/)).not.toBeInTheDocument()
    await user.hover(screen.getByRole('button'))
    expect((await screen.findAllByText(new RegExp(String.raw`so ${PRODUCT_NAME} shows no level`))).length).toBeGreaterThan(0)
  })
})
