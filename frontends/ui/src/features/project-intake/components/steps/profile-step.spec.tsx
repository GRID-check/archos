/**
 * Step 5, Steckbrief, from its fixtures, inside the setup's footer as the page
 * draws it: the Gebäudeklasse as a result with its working folded, the Ampel
 * as chips with their reasons in words, one table of what Piloti found (the
 * decisive rows up front, the rest by topic, each source peeking its page),
 * the line to the Rückfragen while a contradiction is open, and the one way
 * on, „Einrichtung abschließen", with the exact decisions each control sends.
 */
import type { JSX } from 'react'
import { render, screen, within } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  PROFILE_CONFIRMED,
  PROFILE_HOCHHAUS,
  PROFILE_READONLY,
  PROFILE_REVIEW,
} from '@/app/dev/_fixtures/project-setup-profile'
import { INTAKE_CLOSING, INTAKE_READING } from '@/app/dev/_fixtures/project-intake'
import type { IntakeView } from '@/lib/project-intake/types'
import { SetupFooter, StepFooterProvider, useStepFooterChannel } from '../setup-frame'
import { ProfileStep, type ProfileStepProps } from './profile-step'

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }))

const onDecide = vi.fn()
const onComplete = vi.fn()
const onGoTo = vi.fn()

function Framed(props: ProfileStepProps): JSX.Element {
  const footer = useStepFooterChannel()
  return (
    <StepFooterProvider value={footer.channel}>
      <ProfileStep {...props} />
      <SetupFooter step="profile" progress={footer.progress} ownsPrimary={footer.ownsPrimary} slotRef={footer.slotRef} />
    </StepFooterProvider>
  )
}

function setup(view: IntakeView, { busy = false }: { busy?: boolean } = {}) {
  return render(
    <Framed
      view={view}
      projectId={view.projectId}
      busy={busy}
      canDecide={view.canDecide && view.status !== 'completed'}
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

const rows = (testId = 'profile-findings-top'): string[] =>
  [...screen.getByTestId(testId).querySelectorAll('[data-testid^="profile-finding-"]')].map(
    (row) => row.getAttribute('data-testid')?.replace('profile-finding-', '') ?? ''
  )

describe('ProfileStep', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    onDecide.mockResolvedValue(true)
    onComplete.mockResolvedValue(true)
  })

  describe('the Gebäudeklasse', () => {
    it('shows the class as a result with why in one line, with nothing to click to confirm it', () => {
      setup(PROFILE_REVIEW)
      const card = screen.getByTestId('profile-class')
      expect(within(card).getByTestId('profile-class-title')).toHaveTextContent('Gebäudeklasse 5')
      expect(within(card).getByTestId('profile-class-reason')).toHaveTextContent(
        'Escape level 18,4 m · 6 storeys above ground · 14 units'
      )
      // Taken with everything else by the footer's one action.
      expect(within(card).queryByRole('button', { name: /Confirm/ })).toBeNull()
    })

    it('folds the working: every input, which are only suggested, and what it rests on', async () => {
      setup(PROFILE_REVIEW)
      expect(screen.queryByTestId('derivation-unconfirmed-inputs')).toBeNull()
      await userEvent.click(screen.getByRole('button', { name: 'How was it worked out?' }))
      const working = screen.getByTestId('profile-class-working')
      expect(working).toHaveTextContent('Fluchtniveau')
      expect(working).toHaveTextContent('18,4 m · suggestion')
      expect(within(working).getByTestId('derivation-unconfirmed-inputs')).toHaveTextContent(
        'Rests on 4 values nobody has confirmed yet.'
      )
    })

    it('switches between Bauwerke, and sends an open class to the questions', async () => {
      setup(PROFILE_REVIEW)
      await userEvent.click(screen.getByRole('radio', { name: 'Building 2' }))
      const card = screen.getByTestId('profile-class-bw2')
      expect(within(card).getByTestId('profile-class-title')).toHaveTextContent('Gebäudeklasse still open')
      expect(within(card).getByTestId('profile-class-reason')).toHaveTextContent('Still missing:')
      await userEvent.click(within(card).getByRole('button', { name: 'Answer the questions' }))
      expect(onGoTo).toHaveBeenCalledWith('questions')
    })

    it('says a confirmed class is confirmed, and offers no confirm again', () => {
      setup(PROFILE_CONFIRMED)
      expect(screen.getByTestId('profile-class-confirmed')).toHaveTextContent('Confirmed')
      expect(screen.queryByRole('button', { name: /^Confirm Gebäudeklasse/ })).toBeNull()
    })

    it('says a high-rise has no class, and requires OIB-RL 2.3', () => {
      setup(PROFILE_HOCHHAUS)
      expect(screen.getByTestId('profile-class-title')).toHaveTextContent('High-rise')
      expect(screen.getByTestId('profile-class-reason')).toHaveTextContent('OIB-RL 2.3 applies')
      expect(screen.getByTestId('profile-rule-OIB 2.3')).toHaveAttribute('data-status', 'required')
    })
  })

  describe('what applies', () => {
    it('shows each Richtlinie as a chip, its verdict in the dot, and what it was worked out from', () => {
      setup(PROFILE_REVIEW)
      expect(screen.getByRole('button', { name: 'OIB 2 Fire safety, applies' })).toHaveAttribute('data-status', 'required')
      expect(screen.getByRole('button', { name: 'OIB 5 Sound, probably' })).toHaveAttribute('data-status', 'likely')
      expect(screen.getByTestId('profile-rules-basis')).toHaveTextContent('Worked out from 2 confirmed values.')
      expect(screen.getByTestId('profile-rules-basis')).toHaveTextContent('Not legal advice.')
    })

    it('peeks why a Richtlinie applies in the reader’s words, with the Richtlinie and a question to Piloti', async () => {
      setup(PROFILE_REVIEW)
      screen.getByRole('button', { name: 'OIB 5 Sound, probably' }).focus()
      expect(await screen.findByText('Sound protection usually applies.')).toBeInTheDocument()
      expect(screen.queryByText('Sound protection typically applies.')).toBeNull()
      expect(screen.getByRole('link', { name: /Ask Piloti/ })).toHaveAttribute(
        'href',
        expect.stringContaining(`/app/projects/${PROFILE_REVIEW.projectId}/chat?ask=`)
      )
    })
  })

  describe('what Piloti found', () => {
    it('shows the most decisive few, the class’s inputs first, and never a contested value', () => {
      setup(PROFILE_REVIEW)
      expect(rows()).toEqual([
        'fluchtniveau_m@bw1',
        'nutzungseinheiten@bw1',
        'bauwerkstyp@bw1',
        'gebaeudestellung@bw1',
        'oib_ausgabe',
      ])
      expect(screen.queryByTestId('profile-finding-geschosse_oberirdisch@bw1')).toBeNull()
      expect(screen.getByTestId('profile-findings-counts')).toHaveTextContent('7 values · 2 by you')
    })

    it('folds the rest by topic behind one link', async () => {
      setup(PROFILE_REVIEW)
      expect(screen.queryByTestId('profile-topic-A')).toBeNull()
      await userEvent.click(screen.getByRole('button', { name: 'See all 7 values by topic' }))
      const topic = screen.getByTestId('profile-topic-A')
      expect(topic).toHaveTextContent('Projektbasis')
      expect(within(topic).getByTestId('profile-finding-standort_adresse')).toHaveTextContent('By you')
      expect(within(topic).getByTestId('profile-finding-projektphase')).toHaveTextContent('Your answer')
    })

    it('asks nothing to be approved row by row: a value is changed or struck out', async () => {
      setup(PROFILE_REVIEW)
      expect(screen.queryByRole('button', { name: /^Use / })).toBeNull()
      await userEvent.click(screen.getByRole('button', { name: '2023 for OIB-Ausgabe is not right: discard' }))
      expect(onDecide).toHaveBeenLastCalledWith([{ key: 'oib_ausgabe', action: 'dismiss' }])
    })

    it('changes a value with the wizard’s own control, written as the person’s answer', async () => {
      setup(PROFILE_REVIEW)
      await userEvent.click(screen.getByRole('button', { name: 'Change Anzahl Nutzungseinheiten' }))
      const editor = await screen.findByTestId('profile-edit-nutzungseinheiten@bw1')
      const field = within(editor).getByRole('spinbutton')
      await userEvent.clear(field)
      await userEvent.type(field, '16')
      await userEvent.click(within(editor).getByRole('button', { name: 'Use' }))
      expect(onDecide).toHaveBeenLastCalledWith([{ key: 'nutzungseinheiten@bw1', action: 'answer', value: 16 }])
    })

    it('names the source without its file type, and shows its quote when it is focused', async () => {
      setup(PROFILE_REVIEW)
      const row = screen.getByTestId('profile-finding-fluchtniveau_m@bw1')
      const source = within(row).getByRole('button', { name: 'Source of Fluchtniveau: E-02 Schnitt A-A · p. 1' })
      expect(source).toHaveTextContent('+1')
      source.focus()
      const panel = await screen.findByTestId('source-peek-panel')
      expect(panel).toHaveTextContent('Fluchtniveau +18,40 m über Gelände')
      expect(within(panel).getByTestId('page-excerpt')).toBeInTheDocument()
      expect(within(panel).queryByTestId('evidence-chips')).toBeNull()
    })

    it('offers the document itself once the source is pinned', async () => {
      setup(PROFILE_REVIEW)
      const row = screen.getByTestId('profile-finding-nutzungseinheiten@bw1')
      await userEvent.click(within(row).getByTestId('source-peek'))
      const panel = await screen.findByTestId('source-peek-panel')
      const chips = within(panel).getByTestId('evidence-chips')
      expect(chips).toHaveTextContent('Baubeschreibung.pdf, p. 4')
      expect(chips).toHaveTextContent('Wohnungsliste.xlsx')
    })

    it('names the address search and the person’s answer, with nothing to peek at', async () => {
      setup(PROFILE_REVIEW)
      await userEvent.click(screen.getByRole('button', { name: 'See all 7 values by topic' }))
      expect(screen.getByTestId('profile-finding-standort_adresse')).toHaveTextContent('Address search')
      expect(within(screen.getByTestId('profile-finding-standort_adresse')).queryByTestId('source-peek')).toBeNull()
    })

    it('keeps the briefing editor as a quiet way to change everything', () => {
      setup(PROFILE_REVIEW)
      expect(screen.getByRole('link', { name: 'Open the briefing editor for this project' })).toHaveAttribute(
        'href',
        `/app/projects/${PROFILE_REVIEW.projectId}/intake`
      )
    })
  })

  it('points to the Rückfragen while a contradiction is open, instead of a section of its own', async () => {
    setup(PROFILE_REVIEW)
    expect(screen.getByTestId('profile-contradictions')).toHaveTextContent('1 contradiction is still open.')
    await userEvent.click(screen.getByRole('button', { name: 'Resolve it in the questions' }))
    expect(onGoTo).toHaveBeenCalledWith('questions')
    expect(screen.queryByRole('button', { name: /Use 7 for/ })).toBeNull()
  })

  it('has no contradiction line when none is open', () => {
    setup(PROFILE_CONFIRMED)
    expect(screen.queryByTestId('profile-contradictions')).toBeNull()
  })

  it('lets a reader look without deciding', () => {
    setup(PROFILE_READONLY)
    expect(screen.queryByRole('button', { name: /^(Use|Discard|Confirm) / })).toBeNull()
    expect(screen.getByTestId('profile-finding-fluchtniveau_m@bw1')).toHaveTextContent('Suggestion')
    expect(screen.queryByTestId('profile-finish')).toBeNull()
  })

  it('holds every control while a call is in flight, without ever disabling one', async () => {
    setup(PROFILE_REVIEW, { busy: true })
    for (const name of ['2023 for OIB-Ausgabe is not right: discard', 'Take everything and finish']) {
      const control = screen.getByRole('button', { name })
      expect(control).toHaveAttribute('aria-disabled', 'true')
      expect(control).not.toBeDisabled()
    }
    await userEvent.click(screen.getByRole('button', { name: '2023 for OIB-Ausgabe is not right: discard' }))
    await userEvent.click(screen.getByRole('button', { name: 'Take everything and finish' }))
    expect(onDecide).not.toHaveBeenCalled()
    expect(onComplete).not.toHaveBeenCalled()
  })

  describe('finishing', () => {
    const footer = (): HTMLElement => screen.getByTestId('intake-setup-footer')

    it('takes every open value and class as the person’s, then finishes, in one action', async () => {
      setup(PROFILE_REVIEW)
      expect(footer()).toHaveTextContent('What you did not change, Piloti takes as it is, with its source.')
      await userEvent.click(within(footer()).getByRole('button', { name: 'Take everything and finish' }))
      expect(onDecide).toHaveBeenCalledWith([
        { key: 'oib_ausgabe', action: 'confirm' },
        { key: 'bauwerkstyp@bw1', action: 'confirm' },
        { key: 'fluchtniveau_m@bw1', action: 'confirm' },
        { key: 'gebaeudestellung@bw1', action: 'confirm' },
        { key: 'nutzungseinheiten@bw1', action: 'confirm' },
        { key: 'gebaeudeklasse@bw1', action: 'confirm' },
      ])
      expect(onComplete).toHaveBeenCalledTimes(1)
      expect(screen.queryByRole('dialog')).toBeNull()
    })

    it('does not finish when taking the values failed', async () => {
      onDecide.mockResolvedValue(false)
      setup(PROFILE_REVIEW)
      await userEvent.click(within(footer()).getByRole('button', { name: 'Take everything and finish' }))
      expect(onDecide).toHaveBeenCalledTimes(1)
      expect(onComplete).not.toHaveBeenCalled()
    })

    it('only finishes when nothing is left to take', async () => {
      const taken: IntakeView = {
        ...PROFILE_CONFIRMED,
        groups: PROFILE_CONFIRMED.groups.map((group) => ({
          ...group,
          items: group.items.map((item) => ({ ...item, state: 'confirmed' as const })),
        })),
        derivations: PROFILE_CONFIRMED.derivations.map((derivation) => ({
          ...derivation,
          suggestion: derivation.suggestion && { ...derivation.suggestion, state: 'confirmed' as const },
        })),
      }
      setup(taken)
      await userEvent.click(within(footer()).getByRole('button', { name: 'Finish setup' }))
      expect(onDecide).not.toHaveBeenCalled()
      expect(onComplete).toHaveBeenCalledTimes(1)
    })

    it('asks first when finishing closes a past project, with its outcome and period', async () => {
      setup(INTAKE_CLOSING)
      await userEvent.click(within(footer()).getByRole('button', { name: 'Take everything and finish' }))
      expect(onDecide).not.toHaveBeenCalled()
      expect(onComplete).not.toHaveBeenCalled()
      const dialog = await screen.findByRole('dialog')
      expect(dialog).toHaveTextContent('The project is closed with it: outcome “Completed”, period 03/2019 to 08/2022.')
      await userEvent.click(within(dialog).getByRole('button', { name: 'Finish and close' }))
      expect(onDecide).toHaveBeenCalledTimes(1)
      expect(onComplete).toHaveBeenCalledTimes(1)
    })

    it('offers no finish while reading with nothing found, nor to a reader who may not', () => {
      const { unmount } = setup({ ...INTAKE_READING, counts: { ...INTAKE_READING.counts, suggested: 0 }, groups: [] })
      expect(screen.queryByTestId('profile-finish')).toBeNull()
      expect(footer()).not.toHaveTextContent('stays a suggestion')
      unmount()
      setup({ ...PROFILE_REVIEW, canComplete: false })
      expect(screen.queryByTestId('profile-finish')).toBeNull()
    })

    it('keeps the finish while reading with something found, and says more is coming', () => {
      setup(INTAKE_READING)
      expect(screen.getByTestId('profile-finish')).toBeInTheDocument()
      expect(screen.getByTestId('profile-findings')).toHaveTextContent('Piloti is still reading. More values will be added.')
    })
  })
})
