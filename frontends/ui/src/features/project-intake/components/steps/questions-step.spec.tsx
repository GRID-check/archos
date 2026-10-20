/**
 * Step 4, Rückfragen, drawn from its fixtures: one list, one pass, the
 * location's documents with their reasons, the hand-in right at the entry,
 * the progress, the note while Piloti still reads, the few questions of a
 * past project, and the interview folded away.
 */
import { fireEvent, render, screen, within } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  QUESTIONS_CLOSING,
  QUESTIONS_DONE,
  QUESTIONS_READING,
  QUESTIONS_READY,
  QUESTIONS_TYPED_ADDRESS,
} from '@/app/dev/_fixtures/project-setup-questions'
import type { IntakeView } from '@/lib/project-intake/types'
import { QuestionsStep, questionRound } from './questions-step'
import type { SetupStepProps } from './types'

vi.mock('@/shared/context', () => ({
  useAppConfig: () => ({
    fileUpload: {
      acceptedTypes: '.pdf',
      acceptedMimeTypes: ['application/pdf'],
      maxTotalSizeMB: 100,
      maxFileSize: 100 * 1024 * 1024,
      maxTotalSize: 100 * 1024 * 1024,
      maxFileCount: 10,
    },
  }),
}))

const onDecide = vi.fn()
const onFiles = vi.fn()
const onNext = vi.fn()

function setup(view: IntakeView, props: Partial<SetupStepProps> = {}) {
  return render(
    <QuestionsStep
      view={view}
      projectId={view.projectId}
      busy={false}
      canDecide
      canUpload
      uploading={false}
      onDecide={onDecide}
      onFiles={onFiles}
      onReread={vi.fn()}
      onNext={onNext}
      onGoTo={vi.fn()}
      {...props}
    />
  )
}

describe('questionRound', () => {
  it('lists the decisive questions and the open requests once, and folds every other need away', () => {
    const round = questionRound(QUESTIONS_READY)
    expect(round.questions.map((need) => need.key)).toEqual([
      'bgf_oberirdisch@bw1',
      'einheiten_ueber_400@bw1',
      'gebaeudestellung@bw1',
    ])
    expect(round.requests.map((request) => request.determinant)).toEqual([
      'grundstueck',
      'denkmalschutz',
      'standortrisiken',
      'laerm',
    ])
    // The Widmung was found by the reading: settled, so it counts as done.
    expect(round.settledIds).toEqual(['request:widmung'])
    expect(round.more.map((need) => need.key)).toEqual(['vorhabensart', 'widmung'])
  })

  it('asks the Bundesland first when the address was typed', () => {
    const round = questionRound(QUESTIONS_TYPED_ADDRESS)
    expect(round.questions.map((need) => need.key)).toEqual(['bundesland', 'vorhabensart'])
  })
})

describe('QuestionsStep', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    onDecide.mockResolvedValue(true)
  })

  it('shows every question and document request on one screen, with the progress', () => {
    setup(QUESTIONS_READY)
    expect(screen.getByTestId('questions-progress')).toHaveTextContent('1 of 8 done')
    expect(screen.getByTestId('intake-question-bgf_oberirdisch@bw1')).toBeInTheDocument()
    const location = screen.getByTestId('questions-location')
    expect(location).toHaveTextContent('What the location calls for in Wien.')
    expect(within(location).getAllByRole('listitem')).toHaveLength(4)
    expect(screen.queryByTestId('document-request-widmung')).not.toBeInTheDocument()
  })

  it('names the document, why, and the law a request rests on', () => {
    setup(QUESTIONS_READY)
    const card = screen.getByTestId('document-request-denkmalschutz')
    expect(card).toHaveTextContent('Auszug aus der Denkmalliste oder Unterschutzstellungsbescheid')
    expect(card).toHaveTextContent('Bundesdenkmalamts')
    expect(card).toHaveTextContent('Basis: Denkmalschutzgesetz (DMSG)')
  })

  it('takes the document right at the request', () => {
    setup(QUESTIONS_READY)
    const card = screen.getByTestId('document-request-grundstueck')
    const file = new File(['%PDF'], 'Grundbuchauszug.pdf', { type: 'application/pdf' })
    fireEvent.change(within(card).getByTestId('document-hand-in-input'), { target: { files: [file] } })
    expect(onFiles).toHaveBeenCalledWith([file])
  })

  it('marks every open value of a request as not known in one decision', async () => {
    setup(QUESTIONS_READY)
    const card = screen.getByTestId('document-request-grundstueck')
    await userEvent.click(within(card).getByRole('button', { name: 'Grundstück, Fläche und Einlagezahl: not known' }))
    expect(onDecide).toHaveBeenCalledWith([
      { key: 'grundstueck_ez', action: 'unknown' },
      { key: 'grundstuecksflaeche', action: 'unknown' },
    ])
  })

  it('takes a value stated directly on a request', async () => {
    setup(QUESTIONS_READY)
    const field = within(screen.getByTestId('intake-need-grundstueck_ez')).getByRole('textbox')
    await userEvent.type(field, 'EZ 1234')
    await userEvent.click(
      within(screen.getByTestId('intake-need-grundstueck_ez')).getByRole('button', { name: /Einlagezahl/ })
    )
    expect(onDecide).toHaveBeenCalledWith([{ key: 'grundstueck_ez', action: 'answer', value: 'EZ 1234' }])
  })

  it('offers no hand-in where the project takes no documents', () => {
    setup(QUESTIONS_READY, { canUpload: false })
    expect(within(screen.getByTestId('document-request-grundstueck')).queryByTestId('document-hand-in')).toBeNull()
  })

  it('counts an answered question as done when it leaves the list', () => {
    const { rerender } = setup(QUESTIONS_READY)
    const answered = { ...QUESTIONS_READY, questions: QUESTIONS_READY.questions.slice(1) }
    rerender(
      <QuestionsStep
        view={answered}
        projectId={answered.projectId}
        busy={false}
        canDecide
        canUpload
        uploading={false}
        onDecide={onDecide}
        onFiles={onFiles}
        onReread={vi.fn()}
        onNext={onNext}
        onGoTo={vi.fn()}
      />
    )
    expect(screen.getByTestId('questions-progress')).toHaveTextContent('2 of 8 done')
  })

  it('asks for the Bundesland when no geocoder named it', () => {
    setup(QUESTIONS_TYPED_ADDRESS)
    expect(screen.getByTestId('intake-question-bundesland')).toBeInTheDocument()
    expect(screen.getByTestId('questions-location')).toHaveTextContent(
      'Once the federal state is known, Piloti names the documents that apply there.'
    )
  })

  it('says the round follows the reading, and still takes answers', () => {
    setup(QUESTIONS_READING)
    expect(screen.getByTestId('questions-reading-note')).toBeInTheDocument()
    expect(screen.getByTestId('document-request-grundstueck')).toBeInTheDocument()
  })

  it('asks a past project only its Bundesland, and requests no document', () => {
    setup(QUESTIONS_CLOSING)
    expect(screen.getByTestId('questions-closing-note')).toBeInTheDocument()
    expect(screen.getByTestId('intake-question-bundesland')).toBeInTheDocument()
    expect(screen.queryByTestId('questions-location')).toBeNull()
  })

  it('says so when everything is settled', () => {
    setup(QUESTIONS_DONE)
    expect(screen.getByTestId('questions-done')).toHaveTextContent('All done.')
    expect(screen.getByTestId('questions-progress')).toHaveTextContent('5 of 5 done')
  })

  it('folds the optional interview away until it is opened', async () => {
    setup(QUESTIONS_READY)
    expect(screen.queryByTestId('intake-interview')).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: /More details/ }))
    expect(screen.getByTestId('intake-interview')).toHaveTextContent('Question 1 of 2')
  })

  it('goes on to the profile', async () => {
    setup(QUESTIONS_READY)
    await userEvent.click(screen.getByRole('button', { name: 'Continue to the profile' }))
    expect(onNext).toHaveBeenCalled()
  })

  // Carried from the single-page review's spec (7a1b2eb2e): a decisive question as the step asks it.
  describe('a decisive question', () => {
    it('answers with the typed number, only once there is one', async () => {
      setup(QUESTIONS_READY)
      const card = screen.getByTestId('intake-question-bgf_oberirdisch@bw1')
      const answer = within(card).getByRole('button', { name: /Use this answer for Brutto-Grundfläche/ })
      expect(answer).toBeDisabled()
      await userEvent.type(within(card).getByRole('spinbutton'), '1250')
      expect(answer).toBeEnabled()
      await userEvent.click(answer)
      expect(onDecide).toHaveBeenCalledWith([{ key: 'bgf_oberirdisch@bw1', action: 'answer', value: 1250 }])
    })

    it('answers a yes/no question with a boolean', async () => {
      setup(QUESTIONS_READY)
      const card = screen.getByTestId('intake-question-einheiten_ueber_400@bw1')
      await userEvent.click(within(card).getByRole('button', { name: 'No' }))
      await userEvent.click(within(card).getByRole('button', { name: /Use this answer/ }))
      expect(onDecide).toHaveBeenCalledWith([{ key: 'einheiten_ueber_400@bw1', action: 'answer', value: false }])
    })

    it("answers a select question with the option's token", async () => {
      setup(QUESTIONS_READY)
      const card = screen.getByTestId('intake-question-gebaeudestellung@bw1')
      await userEvent.click(within(card).getByRole('combobox'))
      await userEvent.click(await screen.findByRole('option', { name: 'Reihenhaus' }))
      await userEvent.click(within(card).getByRole('button', { name: /Use this answer/ }))
      expect(onDecide).toHaveBeenCalledWith([{ key: 'gebaeudestellung@bw1', action: 'answer', value: 'reihenhaus' }])
    })

    it('says why Piloti asks and where the answer is usually found', async () => {
      setup(QUESTIONS_READY)
      const card = screen.getByTestId('intake-question-bgf_oberirdisch@bw1')
      expect(card).toHaveTextContent('Usually found in: Einreichplan (Plankopf), Baubeschreibung')
      await userEvent.click(within(card).getByRole('button', { name: /why/i }))
      expect(card).toHaveTextContent('Die Fläche entscheidet bei Gebäuden')
    })

    it('records „Nicht bekannt“ as unknown', async () => {
      setup(QUESTIONS_READY)
      await userEvent.click(screen.getByRole('button', { name: /^Brutto-Grundfläche.*: not known/ }))
      expect(onDecide).toHaveBeenCalledWith([{ key: 'bgf_oberirdisch@bw1', action: 'unknown' }])
    })

    it('hands a document in as a row of the card, with a drop ring only while a file is over it', () => {
      setup(QUESTIONS_READY)
      const row = within(screen.getByTestId('intake-question-bgf_oberirdisch@bw1')).getByTestId('document-hand-in')
      expect(row.className).not.toMatch(/\bborder\b/)
      expect(row).not.toHaveAttribute('data-dragging')
      fireEvent.dragEnter(row, { dataTransfer: { types: ['Files'], files: [], items: [] } })
      expect(row).toHaveAttribute('data-dragging')
      expect(row.className).toMatch(/ring-2/)
    })

    it('hands a document in by choosing it', () => {
      setup(QUESTIONS_READY)
      const card = screen.getByTestId('intake-question-bgf_oberirdisch@bw1')
      const file = new File(['%PDF'], 'Flaechenaufstellung.pdf', { type: 'application/pdf' })
      fireEvent.change(within(card).getByTestId('document-hand-in-input'), { target: { files: [file] } })
      expect(onFiles).toHaveBeenCalledWith([file])
    })

    it('hands a document in by dropping it there', () => {
      setup(QUESTIONS_READY)
      const card = screen.getByTestId('intake-question-bgf_oberirdisch@bw1')
      const file = new File(['%PDF'], 'Flaechenaufstellung.pdf', { type: 'application/pdf' })
      fireEvent.drop(within(card).getByTestId('document-hand-in'), {
        dataTransfer: { types: ['Files'], files: [file], items: [] },
      })
      return vi.waitFor(() => expect(onFiles).toHaveBeenCalledWith([file], { truncated: false, unreadable: 0 }))
    })
  })
})
