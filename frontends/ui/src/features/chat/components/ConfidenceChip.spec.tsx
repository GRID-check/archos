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

/**
 * Rule 3 (ADR-0139): the chip leads with what the answer rests on, the count of
 * load-bearing statements backed, and warns only when a named cap fired.
 */
describe('ConfidenceChip under the evidence share', () => {
  const stamps = [
    { text: 'The escape route leads outside [1].', provenance: 'cited', claimType: 'normative', loadBearing: true, support: 1 },
    { text: 'There are 2 drawings [1].', provenance: 'cited', claimType: 'value', loadBearing: true, support: 1 },
    { text: 'The alarm covers all 4 floors [2].', provenance: 'cited', claimType: 'value', loadBearing: true, support: 1 },
    { text: 'No sprinklers are planned [2].', provenance: 'cited', claimType: 'descriptive', loadBearing: false, support: 1 },
    { text: 'Each drawing must be opened.', provenance: 'model_knowledge', claimType: 'normative', loadBearing: true, support: 0 },
  ] as const

  test('leads with the count and names the cap that fired', () => {
    render(
      <ConfidenceChip confidence="medium" cappedReason="normative_claim_uncited" version={2} claimStamps={[...stamps]} />
    )

    expect(screen.getByRole('button')).toHaveTextContent('3 of 4 statements backed · legal statement uncited')
    expect(screen.queryByText(/Confidence: medium/)).not.toBeInTheDocument()
  })

  test('stays muted and names no cap when none fired, the level in the tooltip', async () => {
    const user = userEvent.setup()
    render(<ConfidenceChip confidence="high" version={2} claimStamps={[...stamps.slice(0, 4)]} />)

    expect(screen.getByRole('button')).toHaveTextContent('3 of 3 statements backed')
    expect(screen.getByRole('button')).not.toHaveTextContent('·')
    await user.hover(screen.getByRole('button'))
    expect((await screen.findAllByText(/Assistant self-assessment: high/)).length).toBeGreaterThan(0)
  })

  test('names an uncited statement about the law from the stamps, though no cap fired', () => {
    // The self-report already matched the ceiling, so nothing capped it: the
    // warning must not depend on the model having over-reported (review of #1231).
    render(<ConfidenceChip confidence="medium" version={2} claimStamps={[...stamps]} />)

    const chip = screen.getByRole('button')
    expect(chip).toHaveTextContent('3 of 4 statements backed · legal statement uncited')
    expect(chip).toHaveClass('text-warning')
  })

  test('a listing whose only normative sentence concludes nothing reads backed, muted, with nothing named', () => {
    // Round 3 of #1231: a pure list_files answer showed „Rechtsaussage ohne Beleg" for a next step.
    const listing = [
      { text: 'Abgabepläne · 8 · …', provenance: 'record', claimType: 'value', loadBearing: true, support: 1, verdict: false },
      { text: 'Berichte · 2 · …', provenance: 'record', claimType: 'value', loadBearing: true, support: 1, verdict: false },
      { text: 'Welche Maßstäbe sie tragen, muss im Einzelnen geöffnet werden.', provenance: 'model_knowledge', claimType: 'normative', loadBearing: false, support: 0, verdict: false },
    ] as const
    render(<ConfidenceChip confidence="high" version={2} claimStamps={[...listing]} />)

    const chip = screen.getByRole('button')
    expect(chip).toHaveTextContent('2 of 2 statements backed')
    expect(chip).not.toHaveTextContent('·')
    expect(chip).not.toHaveClass('text-warning')
  })

  test('names a citation that did not hold', () => {
    const dropped = [
      ...stamps.slice(0, 3),
      { text: 'The stair is 1.20 m wide [Beleg nicht verifiziert].', provenance: 'cited_dropped', claimType: 'value', loadBearing: true, support: 0 },
    ] as const
    render(<ConfidenceChip confidence="medium" version={2} claimStamps={[...dropped]} />)

    expect(screen.getByRole('button')).toHaveTextContent('3 of 4 statements backed · citation unverified')
  })

  test('counts a partly backed claim as partly, and says when the judge could not check', () => {
    // Round 5 of #1231: „0 von 2 belegt" on two cited claims read as unbacked.
    const partly = [
      { text: 'The door is 1 m wide [1].', provenance: 'observed', claimType: 'value', loadBearing: true, support: 0.5, judged: 'supported' },
      { text: 'The alarm covers all 4 floors [2].', provenance: 'cited', claimType: 'value', loadBearing: true, support: 1, judged: 'supported' },
    ] as const
    const { unmount } = render(<ConfidenceChip confidence="medium" version={2} claimStamps={[...partly]} />)
    expect(screen.getByRole('button')).toHaveTextContent('1 of 2 statements backed · 1 partly')
    unmount()

    const unchecked = partly.map((stamp) => ({ ...stamp, support: 0.5, judged: 'unavailable' }) as const)
    render(<ConfidenceChip confidence="medium" version={2} claimStamps={unchecked} />)
    expect(screen.getByRole('button')).toHaveTextContent('0 of 2 statements backed · 2 partly · evidence check unavailable')
  })

  test('names a legal statement its own source contradicts', () => {
    const contradicted = [
      ...stamps.slice(0, 3),
      { text: 'Spiral stairs are allowed [1].', provenance: 'cited', claimType: 'normative', loadBearing: true, support: 0, verdict: true, judged: 'contradicted' },
    ] as const
    render(<ConfidenceChip confidence="low" version={2} claimStamps={[...contradicted]} />)

    expect(screen.getByRole('button')).toHaveTextContent('3 of 4 statements backed · contradicts its source')
  })

  test('a rule-3 answer whose stamps carry no support falls back to the level', () => {
    const bare = stamps.map(({ support: _support, ...stamp }) => stamp)
    render(<ConfidenceChip confidence="medium" version={2} claimStamps={bare} />)

    expect(screen.getByText('Confidence: medium')).toBeInTheDocument()
  })
})
