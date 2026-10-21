import { render, screen } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { describe, test, expect } from 'vitest'
import { ConfidenceChip } from './ConfidenceChip'

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
describe('ConfidenceChip under the per-sentence rule', () => {
  const stamps = [
    { text: 'Anna has three open approvals.', provenance: 'record', claimType: 'value', loadBearing: true },
    { text: 'The height is 2.50 m [1].', provenance: 'cited', claimType: 'normative', loadBearing: true },
    { text: 'That also holds for the attic.', provenance: 'reasoning', claimType: 'descriptive', loadBearing: false },
    { text: 'Section 5 allows it.', provenance: 'model_knowledge', claimType: 'normative', loadBearing: true },
  ] as const

  test('shows the mix of what the sentences rest on', async () => {
    const user = userEvent.setup()
    render(
      <ConfidenceChip confidence="low" cappedReason="normative_claim_uncited" version={2} claimStamps={[...stamps]} />
    )

    await user.hover(screen.getByRole('button'))

    const mix = await screen.findAllByTestId('confidence-claim-mix')
    expect(mix[0]).toHaveTextContent('2 statements backed · 1 inference · 1 legal statement without a source')
    expect(
      (await screen.findAllByText(/A workspace record or a measurement does not back a legal statement\./)).length
    ).toBeGreaterThan(0)
    expect((await screen.findAllByText(/held to the weakest statement/)).length).toBeGreaterThan(0)
  })

  test('a stored turn without a version keeps the answer-level copy and shows no mix', async () => {
    const user = userEvent.setup()
    render(<ConfidenceChip confidence="low" cappedReason="ungrounded" claimStamps={[...stamps]} />)

    await user.hover(screen.getByRole('button'))

    expect((await screen.findAllByText(/Low confidence: answer not backed by sources\./)).length).toBeGreaterThan(0)
    expect(screen.queryByTestId('confidence-claim-mix')).not.toBeInTheDocument()
  })
})
