/**
 * Step 5, Steckbrief, from its fixtures: the ticket's order (contradictions,
 * the decisive values one by one, the rest at once, the derivations, the rule
 * set's Ampel, the finish), each value's confidence in words, and the exact
 * decisions each control sends.
 */
import { render, screen, within } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  PROFILE_CONFIRMED,
  PROFILE_HOCHHAUS,
  PROFILE_READONLY,
  PROFILE_REVIEW,
} from '@/app/dev/_fixtures/project-setup-profile'
import { INTAKE_CLOSING, INTAKE_READING, INTAKE_READY } from '@/app/dev/_fixtures/project-intake'
import type { IntakeView } from '@/lib/project-intake/types'
import { ProfileStep } from './profile-step'

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }))

const onDecide = vi.fn()
const onComplete = vi.fn()
const onGoTo = vi.fn()

function setup(view: IntakeView, { busy = false }: { busy?: boolean } = {}) {
  return render(
    <ProfileStep
      view={view}
      projectId={view.projectId}
      busy={busy}
      canDecide={view.canDecide}
      canUpload
      uploading={false}
      onDecide={onDecide}
      onFiles={vi.fn()}
      onReread={vi.fn()}
      onGoTo={onGoTo}
      onComplete={onComplete}
    />
  )
}

const follows = (ids: string[]) => {
  const nodes = ids.map((id) => screen.getByTestId(id))
  nodes.slice(1).forEach((node, index) => {
    expect(nodes[index].compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING, `${ids[index]} before ${ids[index + 1]}`).toBeTruthy()
  })
}

describe('ProfileStep', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    onDecide.mockResolvedValue(true)
    onComplete.mockResolvedValue(true)
  })

  it('shows the Steckbrief in the ticket’s order', () => {
    setup(PROFILE_REVIEW)
    follows([
      'intake-contradictions',
      'profile-decisive',
      'intake-review',
      'intake-derivations',
      'profile-rules',
      'intake-complete',
    ])
  })

  it('puts each decisive suggestion on a card of its own, and not again among the rest', () => {
    setup(PROFILE_REVIEW)
    const decisive = screen.getByTestId('profile-decisive')
    const cards = [...decisive.querySelectorAll('[data-testid^="profile-decisive-"]')]
    expect(cards.map((card) => card.getAttribute('data-testid'))).toEqual([
      'profile-decisive-fluchtniveau_m@bw1',
      'profile-decisive-nutzungseinheiten@bw1',
    ])
    const rest = screen.getByTestId('intake-review')
    expect(within(rest).queryByTestId('intake-suggestion-fluchtniveau_m@bw1')).toBeNull()
    expect(within(rest).queryByTestId('intake-suggestion-geschosse_oberirdisch@bw1')).toBeNull()
    expect(within(rest).getByTestId('intake-suggestion-oib_ausgabe')).toBeInTheDocument()
  })

  it('takes a decisive value on its own, and the rest in one call without it', async () => {
    setup(PROFILE_REVIEW)
    await userEvent.click(screen.getByRole('button', { name: 'Use 18.4 m for Fluchtniveau (Zielzustand)' }))
    expect(onDecide).toHaveBeenLastCalledWith([{ key: 'fluchtniveau_m@bw1', action: 'confirm' }])

    await userEvent.click(screen.getByRole('button', { name: /Discard 14 for Anzahl Nutzungseinheiten/ }))
    expect(onDecide).toHaveBeenLastCalledWith([{ key: 'nutzungseinheiten@bw1', action: 'dismiss' }])

    await userEvent.click(screen.getByRole('button', { name: 'Use 3 remaining values' }))
    expect(onDecide).toHaveBeenLastCalledWith([
      { key: 'oib_ausgabe', action: 'confirm' },
      { key: 'bauwerkstyp@bw1', action: 'confirm' },
      { key: 'gebaeudestellung@bw1', action: 'confirm' },
    ])
  })

  it('says how sure each value is in words, from who confirmed it and how many sources agree', () => {
    setup(PROFILE_REVIEW)
    expect(screen.getByTestId('profile-decisive-fluchtniveau_m@bw1')).toHaveTextContent('Suggestion, 2 sources agree')
    expect(screen.getByTestId('intake-suggestion-oib_ausgabe')).toHaveTextContent('Suggestion from one source')
    expect(screen.getByTestId('intake-suggestion-standort_adresse')).toHaveTextContent('Confirmed')
    expect(screen.getByTestId('intake-suggestion-projektphase')).toHaveTextContent('Your answer')
    const contradiction = screen.getByTestId('intake-contradictions')
    expect(within(contradiction).getAllByText('Suggestion from one source')).toHaveLength(2)
    expect(screen.queryByText(/%/)).toBeNull()
  })

  it('offers the excerpt of a cited PDF page, and none for a file without pages', () => {
    setup(PROFILE_REVIEW)
    const units = screen.getByTestId('profile-decisive-nutzungseinheiten@bw1')
    expect(within(units).getAllByTestId('page-excerpt-toggle')).toHaveLength(1)
    expect(within(units).getByRole('button', { name: 'Hide the excerpt of Baubeschreibung.pdf, page 4' })).toBeInTheDocument()
    const edition = screen.getByTestId('intake-suggestion-oib_ausgabe')
    expect(within(edition).getByRole('button', { name: 'Show the excerpt of Bescheid.pdf, page 1' })).toHaveAttribute('aria-expanded', 'false')
    expect(within(edition).queryByTestId('page-excerpt')).toBeNull()
  })

  it('says what a suggested class rests on before it is taken', async () => {
    setup(PROFILE_REVIEW)
    const card = screen.getByTestId('intake-derivation-bw1')
    expect(within(card).getByTestId('derivation-unconfirmed-inputs')).toHaveTextContent('Rests on 4 values nobody has confirmed yet.')
    await userEvent.click(within(card).getByRole('button', { name: /Use Gebäudeklasse GK 5 for Building 1/ }))
    expect(onDecide).toHaveBeenLastCalledWith([{ key: 'gebaeudeklasse@bw1', action: 'confirm' }])
  })

  it('shows the Ampel from the confirmed values, and says what it was computed from', () => {
    setup(PROFILE_REVIEW)
    const rules = screen.getByTestId('profile-rules')
    expect(within(rules).getByTestId('profile-rules-basis')).toHaveTextContent('Worked out from 2 confirmed values.')
    expect(within(rules).getByTestId('profile-rules-basis')).toHaveTextContent('The Gebäudeklasse is not confirmed yet.')
    expect(within(rules).getByText('OIB 2')).toBeInTheDocument()
  })

  it('requires OIB-RL 2.3 for a high-rise, which has no class', () => {
    setup(PROFILE_HOCHHAUS)
    expect(screen.getByTestId('intake-derivation-bw1')).toHaveTextContent('High-rise')
    const rules = screen.getByTestId('profile-rules')
    expect(within(rules).getByText('OIB 2.3')).toBeInTheDocument()
  })

  it('lets a reader look without deciding', () => {
    setup(PROFILE_READONLY)
    for (const id of ['profile-decisive', 'intake-review']) {
      expect(within(screen.getByTestId(id)).queryByRole('button', { name: /^(Use|Discard) / })).toBeNull()
    }
    const shown = [screen.getByTestId('intake-contradictions'), screen.getByTestId('intake-derivations')]
    const buttons = shown.flatMap((section) => within(section).queryAllByRole('button', { name: /^(Use|Discard) / }))
    expect(buttons.length).toBeGreaterThan(0)
    for (const button of buttons) expect(button).toBeDisabled()
    expect(screen.queryByTestId('intake-complete')).toBeNull()
  })

  describe('finishing', () => {
    it('says what is confirmed, the class, the rule sets and where each open item goes', async () => {
      setup(PROFILE_REVIEW)
      await userEvent.click(screen.getByRole('button', { name: 'Finish setup' }))
      const summary = await screen.findByTestId('intake-finish-summary')
      expect(within(summary).getByTestId('intake-finish-confirmed')).toHaveTextContent('2 values')
      expect(within(summary).getByTestId('intake-finish-class')).toHaveTextContent('Building 1: GK 5, suggested')
      expect(within(summary).getByTestId('intake-finish-class')).toHaveTextContent('Building 2: still open')
      expect(within(summary).getByTestId('intake-finish-rules')).toHaveTextContent('required')
      expect(within(summary).getByTestId('intake-finish-contradictions')).toHaveTextContent('1 contradiction')
      expect(within(summary).getByTestId('intake-finish-contradictions')).toHaveTextContent('decided at the top of the profile')
      expect(within(summary).getByTestId('intake-finish-questions')).toHaveTextContent('3 questions')
      expect(within(summary).getByTestId('intake-finish-questions')).toHaveTextContent('answered in the Rückfragen step')
      expect(within(summary).getByTestId('intake-finish-unconfirmed')).toHaveTextContent('stay suggestions in the project briefing')
    })

    it('goes to the Rückfragen to resolve the open items now', async () => {
      setup(PROFILE_REVIEW)
      await userEvent.click(screen.getByRole('button', { name: 'Finish setup' }))
      await userEvent.click(await screen.findByTestId('intake-finish-resolve'))
      expect(onGoTo).toHaveBeenCalledWith('questions')
      expect(onComplete).not.toHaveBeenCalled()
    })

    it('stays on the Steckbrief when only a contradiction is open', async () => {
      setup({ ...PROFILE_REVIEW, questions: [] })
      await userEvent.click(screen.getByRole('button', { name: 'Finish setup' }))
      await userEvent.click(await screen.findByTestId('intake-finish-resolve'))
      expect(onGoTo).not.toHaveBeenCalled()
      expect(screen.getByTestId('intake-contradictions')).toBeInTheDocument()
    })

    it('makes finishing the next thing once nothing is open, and finishes on confirm', async () => {
      setup(PROFILE_CONFIRMED)
      expect(screen.queryByTestId('intake-contradictions')).toBeNull()
      expect(screen.queryByTestId('profile-decisive')).toBeNull()
      expect(screen.getByTestId('intake-complete')).toHaveAttribute('data-primary', 'true')
      await userEvent.click(screen.getByRole('button', { name: 'Finish setup' }))
      const summary = await screen.findByTestId('intake-finish-summary')
      expect(within(summary).getByTestId('intake-finish-class')).toHaveTextContent('GK 5, confirmed')
      expect(within(summary).queryByTestId('intake-finish-resolve')).toBeNull()
      await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Finish setup' }))
      expect(onComplete).toHaveBeenCalledTimes(1)
    })
  })

  // Carried from the single-page setup's spec (7a1b2eb2e), where these sections were tested in the frame.
  describe('marks', () => {
    it('marks a decisive value as a neutral property with a glyph, and a contradiction in the warning tone', () => {
      setup(INTAKE_READY)
      const decisive = within(screen.getByTestId('profile-decisive-fluchtniveau_m@bw1')).getByText('Decisive')
      expect(decisive.className).not.toMatch(/warning/)
      expect(decisive.querySelector('svg')).not.toBeNull()
      const contested = within(screen.getByTestId('intake-contradictions')).getByText('2 different values found')
      expect(contested.className).toMatch(/warning/)
      expect(contested.querySelector('svg')).not.toBeNull()
      expect(screen.getByTestId('intake-suggestion-standort_adresse')).toHaveTextContent('Confirmed')
    })
  })

  describe('derivations', () => {
    it('shows the Gebäudeklasse of a Bauwerk with its inputs, and „still open“ with what is missing', () => {
      setup(INTAKE_READY)
      const done = screen.getByTestId('intake-derivation-bw1')
      expect(done).toHaveTextContent('GK 5')
      expect(done).toHaveTextContent('Anzahl oberirdischer Geschoße (Zielzustand): 6 · suggested')
      expect(done).toHaveTextContent('Gebäudestellung: angebaut')
      expect(done).not.toHaveTextContent('Gebäudestellung: angebaut · suggested')
      const suggested = within(done).getByText(/Anzahl oberirdischer Geschoße \(Zielzustand\): 6 · suggested/)
      expect(suggested.closest('[data-slot="chip"]')?.className).not.toMatch(/warning/)
      expect(done).toHaveTextContent('OIB-Richtlinien, Begriffsbestimmungen (Ausgabe 2023)')

      const open = screen.getByTestId('intake-derivation-bw2')
      expect(open).toHaveTextContent('still open')
      expect(open).toHaveTextContent('Still missing:')
      expect(within(open).queryByRole('button')).toBeNull()
    })

    it('says a Hochhaus has no Gebäudeklasse', () => {
      setup({
        ...INTAKE_READY,
        derivations: [{ ...INTAKE_READY.derivations[1], bauwerkId: 'bw3', hochhaus: true, missing: [] }],
      })
      expect(screen.getByTestId('intake-derivation-bw3')).toHaveTextContent('High-rise')
    })
  })

  describe('evidence', () => {
    it('names the file and the page, and shows the quote on hover', async () => {
      setup(INTAKE_READY)
      const contradictions = screen.getByTestId('intake-contradictions')
      const chip = await within(contradictions).findByRole('button', { name: /Baubeschreibung\.pdf, p\. 3/ })
      expect(chip).toHaveTextContent('Baubeschreibung.pdf, p. 3')
      await userEvent.hover(chip)
      expect(await screen.findByText(/insgesamt sechs oberirdische Geschoße/)).toBeInTheDocument()
    })

    it('says a spreadsheet\'s source without a page, and offers it no excerpt', () => {
      setup(INTAKE_READY)
      const units = screen.getByTestId('profile-decisive-nutzungseinheiten@bw1')
      expect(units).toHaveTextContent('Wohnungsliste.xlsx')
      expect(units).not.toHaveTextContent('Wohnungsliste.xlsx, p.')
      expect(within(units).queryByRole('button', { name: /excerpt of Wohnungsliste/ })).toBeNull()
    })
  })

  describe('decisions', () => {
    it('confirms the profile\'s own value of a contradiction', async () => {
      setup(INTAKE_READY)
      await userEvent.click(screen.getByRole('button', { name: /Use 6 for Anzahl oberirdischer Geschoße/ }))
      expect(onDecide).toHaveBeenCalledWith([{ key: 'geschosse_oberirdisch@bw1', action: 'confirm' }])
    })

    it('confirms an alternative with its index', async () => {
      setup(INTAKE_READY)
      await userEvent.click(screen.getByRole('button', { name: /Use 7 for Anzahl oberirdischer Geschoße/ }))
      expect(onDecide).toHaveBeenCalledWith([{ key: 'geschosse_oberirdisch@bw1', action: 'confirm', alternativeIndex: 0 }])
    })

    it('discards an alternative, and offers no discard for the profile\'s own value', async () => {
      setup(INTAKE_READY)
      expect(screen.getAllByRole('button', { name: /Discard .* for Anzahl oberirdischer Geschoße/ })).toHaveLength(1)
      await userEvent.click(screen.getByRole('button', { name: /Discard 7 for Anzahl oberirdischer Geschoße/ }))
      expect(onDecide).toHaveBeenCalledWith([{ key: 'geschosse_oberirdisch@bw1', action: 'dismiss', alternativeIndex: 0 }])
    })

    it('offers no one-by-one confirm for a value that decides nothing: the rest is taken together', async () => {
      setup(INTAKE_READY)
      expect(screen.queryByRole('button', { name: /Use 2023 for OIB-Ausgabe/ })).toBeNull()
      await userEvent.click(screen.getByRole('button', { name: /Discard 2023 for OIB-Ausgabe/ }))
      expect(onDecide).toHaveBeenLastCalledWith([{ key: 'oib_ausgabe', action: 'dismiss' }])
    })

    it('holds every control while a call is in flight, without ever disabling one', async () => {
      setup(INTAKE_READY, { busy: true })
      for (const name of [/Use 6 for Anzahl/, /Use 18.4 m for Fluchtniveau/, /Use 3 remaining/, /Use Gebäudeklasse GK 5/, 'Finish setup']) {
        const control = screen.getByRole('button', { name })
        expect(control).toHaveAttribute('aria-disabled', 'true')
        expect(control).not.toBeDisabled()
      }
      await userEvent.click(screen.getByRole('button', { name: /Use 6 for Anzahl/ }))
      await userEvent.click(screen.getByRole('button', { name: 'Finish setup' }))
      expect(onDecide).not.toHaveBeenCalled()
      expect(screen.queryByRole('dialog')).toBeNull()
    })

    it('shows the busy label on the control that was pressed, once the wait is noticeable, and keeps its focus', async () => {
      let settle: (ok: boolean) => void = () => undefined
      onDecide.mockReturnValue(new Promise<boolean>((resolve) => (settle = resolve)))
      setup(INTAKE_READY)
      const confirm = screen.getByRole('button', { name: /Use 6 for Anzahl/ })
      confirm.focus()
      await userEvent.click(confirm)
      expect(confirm).toHaveAttribute('aria-busy', 'true')
      expect(confirm).toHaveFocus()
      await userEvent.click(confirm)
      expect(onDecide).toHaveBeenCalledTimes(1)
      await vi.waitFor(() => expect(confirm).toHaveTextContent('Using …'))
      settle(true)
      await vi.waitFor(() => expect(confirm).not.toHaveAttribute('aria-busy'))
    })
  })

  describe('the finish button', () => {
    it('keeps the finish button while reading with something to review, as a secondary', () => {
      setup(INTAKE_READING)
      expect(screen.getByTestId('intake-complete')).not.toHaveAttribute('data-primary')
      expect(screen.getByTestId('intake-reading-skeleton')).toBeInTheDocument()
    })

    it('hides the finish button while reading with nothing found yet', () => {
      setup({ ...INTAKE_READING, counts: { ...INTAKE_READING.counts, suggested: 0 }, groups: [] })
      expect(screen.queryByTestId('intake-complete')).toBeNull()
    })

    it('is the ink primary only when nothing is open, and stays on screen on a phone', () => {
      setup({ ...INTAKE_READY, contradictions: [], questions: [] })
      expect(screen.getByTestId('intake-complete')).toHaveAttribute('data-primary')
      expect(screen.getByTestId('intake-complete')).toHaveClass('max-sm:sticky', 'max-sm:bottom-0')
      expect(screen.queryByTestId('intake-open')).toBeNull()
    })

    it('is a secondary button that does not float and says what is still open', () => {
      setup(INTAKE_READY)
      expect(screen.getByTestId('intake-complete')).not.toHaveAttribute('data-primary')
      expect(screen.getByTestId('intake-complete')).not.toHaveClass('max-sm:sticky')
      expect(screen.getByTestId('intake-open')).toHaveTextContent('Still open: 1 contradiction, 3 questions – you can finish anyway.')
      expect(screen.getByRole('button', { name: 'Finish setup' }).className).toMatch(/bg-secondary/)
    })

    it('names only what is open', () => {
      setup({ ...INTAKE_READY, contradictions: [] })
      expect(screen.getByTestId('intake-open')).toHaveTextContent('Still open: 3 questions')
    })

    it('asks before it finishes, then completes', async () => {
      setup(INTAKE_READY)
      await userEvent.click(screen.getByRole('button', { name: 'Finish setup' }))
      expect(onComplete).not.toHaveBeenCalled()
      const dialog = await screen.findByRole('dialog')
      expect(dialog).toHaveTextContent('The review ends and the confirmed values stay on the project.')
      await userEvent.click(within(dialog).getByRole('button', { name: 'Finish setup' }))
      expect(onComplete).toHaveBeenCalledTimes(1)
    })

    it('says a closing intent closes the project with outcome and period', async () => {
      setup(INTAKE_CLOSING)
      expect(screen.getByTestId('intake-complete')).toHaveTextContent('This closes the project: outcome “Completed”, period 03/2019 to 08/2022.')
      await userEvent.click(screen.getByRole('button', { name: 'Finish setup' }))
      expect(await screen.findByRole('dialog')).toHaveTextContent('the project is closed: outcome “Completed”, period 03/2019 to 08/2022.')
    })

    it('offers no finish to a reader who may not', () => {
      setup({ ...INTAKE_READY, canComplete: false })
      expect(screen.queryByRole('button', { name: 'Finish setup' })).toBeNull()
    })
  })
})
