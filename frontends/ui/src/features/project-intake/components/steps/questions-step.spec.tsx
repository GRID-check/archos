/**
 * Step 4, Rückfragen, drawn from its fixtures: the round in three groups, one
 * question at a time, each answered with the wizard's own control, marked
 * „weiß ich nicht", or settled by handing in its document; the location's
 * documents with their reasons; the contradictions, settled by picking a
 * value; the note while Piloti still reads; the few questions of a past
 * project; and the interview folded away.
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

function props(view: IntakeView, overrides: Partial<SetupStepProps> = {}): SetupStepProps {
  return {
    view,
    projectId: view.projectId,
    busy: false,
    canDecide: true,
    canUpload: true,
    uploading: false,
    onDecide,
    onFiles,
    onReread: vi.fn(),
    onNext,
    onGoTo: vi.fn(),
    ...overrides,
  }
}

function setup(view: IntakeView, overrides: Partial<SetupStepProps> = {}) {
  return render(<QuestionsStep {...props(view, overrides)} />)
}

const list = () => screen.getByTestId('questions-list')
const choose = (name: RegExp) => userEvent.click(within(list()).getByRole('button', { name }))

describe('questionRound', () => {
  it('lists the decisive questions, the open requests and the contradictions once, and folds every other need away', () => {
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
    expect(round.contradictions.map((item) => item.key)).toEqual(['geschosse_oberirdisch@bw1'])
    expect(round.openIds).toEqual([
      'question:bgf_oberirdisch@bw1',
      'question:einheiten_ueber_400@bw1',
      'question:gebaeudestellung@bw1',
      'request:grundstueck',
      'request:denkmalschutz',
      'request:standortrisiken',
      'request:laerm',
      'contradiction:geschosse_oberirdisch@bw1',
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

  it('lists the round in its three groups, the settled document done', () => {
    setup(QUESTIONS_READY)
    expect(within(screen.getByTestId('questions-group-missing')).getAllByRole('listitem')).toHaveLength(3)
    const location = within(screen.getByTestId('questions-group-location')).getAllByRole('listitem')
    expect(location).toHaveLength(5)
    expect(location[4]).toHaveTextContent('Widmung und Bebauungsbestimmungen')
    expect(location[4]).toHaveTextContent('done')
    expect(within(screen.getByTestId('questions-group-contradiction')).getByRole('button')).toHaveTextContent(
      'Anzahl oberirdischer Geschoße (Zielzustand): 6 or 7?'
    )
  })

  it('asks one question at a time, with where it sits and why it matters', () => {
    setup(QUESTIONS_READY)
    const card = screen.getByTestId('intake-question-bgf_oberirdisch@bw1')
    expect(card).toHaveTextContent('Question 1 of 9 · decides the building class')
    expect(card).toHaveTextContent('Die Fläche entscheidet bei Gebäuden')
    expect(screen.queryByTestId('intake-question-einheiten_ueber_400@bw1')).toBeNull()
    expect(within(list()).getByRole('button', { current: true })).toHaveTextContent('Brutto-Grundfläche')
  })

  it('answers with the typed number, only once there is one, and moves on with the value in the list', async () => {
    setup(QUESTIONS_READY)
    const card = screen.getByTestId('intake-question-bgf_oberirdisch@bw1')
    const answer = within(card).getByRole('button', { name: 'Use and continue' })
    expect(answer).toBeDisabled()
    await userEvent.type(within(card).getByRole('spinbutton'), '1250')
    await userEvent.click(answer)
    expect(onDecide).toHaveBeenCalledWith([{ key: 'bgf_oberirdisch@bw1', action: 'answer', value: 1250 }])
    expect(await screen.findByTestId('intake-question-einheiten_ueber_400@bw1')).toHaveTextContent('Question 2 of 9')
    const done = within(screen.getByTestId('questions-group-missing')).getAllByRole('listitem')[0]
    expect(done).toHaveTextContent('1 250') // German grouping
    expect(done).toHaveTextContent('done')
  })

  it('stays on the question when the answer did not go through', async () => {
    onDecide.mockResolvedValue(false)
    setup(QUESTIONS_READY)
    const card = screen.getByTestId('intake-question-bgf_oberirdisch@bw1')
    await userEvent.type(within(card).getByRole('spinbutton'), '1250')
    await userEvent.click(within(card).getByRole('button', { name: 'Use and continue' }))
    expect(screen.getByTestId('intake-question-bgf_oberirdisch@bw1')).toBeInTheDocument()
  })

  it('answers a yes/no question with a boolean', async () => {
    setup(QUESTIONS_READY)
    await choose(/Nutzungseinheiten/)
    const card = screen.getByTestId('intake-question-einheiten_ueber_400@bw1')
    await userEvent.click(within(card).getByRole('button', { name: 'No' }))
    await userEvent.click(within(card).getByRole('button', { name: 'Use and continue' }))
    expect(onDecide).toHaveBeenCalledWith([{ key: 'einheiten_ueber_400@bw1', action: 'answer', value: false }])
  })

  it("answers a select question with the option's token", async () => {
    setup(QUESTIONS_READY)
    await choose(/Gebäudestellung/)
    const card = screen.getByTestId('intake-question-gebaeudestellung@bw1')
    await userEvent.click(within(card).getByRole('combobox'))
    await userEvent.click(await screen.findByRole('option', { name: 'Reihenhaus' }))
    await userEvent.click(within(card).getByRole('button', { name: 'Use and continue' }))
    expect(onDecide).toHaveBeenCalledWith([{ key: 'gebaeudestellung@bw1', action: 'answer', value: 'reihenhaus' }])
  })

  it('records „Weiß ich nicht“ as unknown, and moves on', async () => {
    setup(QUESTIONS_READY)
    await userEvent.click(screen.getByRole('button', { name: /^Brutto-Grundfläche.*: I don't know/ }))
    expect(onDecide).toHaveBeenCalledWith([{ key: 'bgf_oberirdisch@bw1', action: 'unknown' }])
    expect(await screen.findByTestId('intake-question-einheiten_ueber_400@bw1')).toBeInTheDocument()
    expect(within(screen.getByTestId('questions-group-missing')).getAllByRole('listitem')[0]).toHaveTextContent('not known')
  })

  it('says where the answer usually stands, and takes the document there', async () => {
    setup(QUESTIONS_READY)
    const card = screen.getByTestId('intake-question-bgf_oberirdisch@bw1')
    const row = within(card).getByTestId('document-hand-in')
    expect(row).toHaveTextContent('Einreichplan (Plankopf) or Baubeschreibung')
    const file = new File(['%PDF'], 'Flaechenaufstellung.pdf', { type: 'application/pdf' })
    fireEvent.change(within(card).getByTestId('document-hand-in-input'), { target: { files: [file] } })
    expect(onFiles).toHaveBeenCalledWith([file])
    // Handed in: the round moves on, Piloti reads the answer out of it.
    expect(await screen.findByTestId('intake-question-einheiten_ueber_400@bw1')).toBeInTheDocument()
  })

  it('takes a document dropped on the row', () => {
    setup(QUESTIONS_READY)
    const row = within(screen.getByTestId('intake-question-bgf_oberirdisch@bw1')).getByTestId('document-hand-in')
    const file = new File(['%PDF'], 'Flaechenaufstellung.pdf', { type: 'application/pdf' })
    fireEvent.drop(row, { dataTransfer: { types: ['Files'], files: [file], items: [] } })
    return vi.waitFor(() => expect(onFiles).toHaveBeenCalledWith([file], { truncated: false, unreadable: 0 }))
  })

  it('offers no hand-in where the project takes no documents', () => {
    setup(QUESTIONS_READY, { canUpload: false })
    expect(screen.queryByTestId('document-hand-in')).toBeNull()
  })

  describe('a document the location asks for', () => {
    it('names the document, why, the law it rests on and the place', async () => {
      setup(QUESTIONS_READY)
      await choose(/Denkmal- und Ortsbildschutz/)
      const card = screen.getByTestId('document-request-denkmalschutz')
      expect(card).toHaveTextContent('Auszug aus der Denkmalliste oder Unterschutzstellungsbescheid')
      expect(card).toHaveTextContent('Bundesdenkmalamts')
      expect(card).toHaveTextContent('Basis: Denkmalschutzgesetz (DMSG)')
      expect(card).toHaveTextContent('called for by the location in Wien')
    })

    it('takes its values stated directly', async () => {
      setup(QUESTIONS_READY)
      await choose(/Grundstück, Fläche und Einlagezahl/)
      const card = screen.getByTestId('document-request-grundstueck')
      await userEvent.type(within(screen.getByTestId('intake-need-grundstueck_ez')).getByRole('textbox'), 'EZ 1234')
      await userEvent.click(within(card).getByRole('button', { name: 'Use and continue' }))
      expect(onDecide).toHaveBeenCalledWith([{ key: 'grundstueck_ez', action: 'answer', value: 'EZ 1234' }])
    })

    it('marks every open value as not known in one decision', async () => {
      setup(QUESTIONS_READY)
      await choose(/Grundstück, Fläche und Einlagezahl/)
      await userEvent.click(screen.getByRole('button', { name: "Grundstück, Fläche und Einlagezahl: I don't know" }))
      expect(onDecide).toHaveBeenCalledWith([
        { key: 'grundstueck_ez', action: 'unknown' },
        { key: 'grundstuecksflaeche', action: 'unknown' },
      ])
    })

    it('says the documents follow once the Bundesland is known', async () => {
      setup(QUESTIONS_TYPED_ADDRESS)
      expect(screen.getByTestId('intake-question-bundesland')).toBeInTheDocument()
      await choose(/Grundstück, Fläche und Einlagezahl/)
      expect(screen.getByTestId('document-request-grundstueck').textContent).toMatch(/· called for by the location(?! in)/)
    })
  })

  describe('a contradiction', () => {
    it('confirms the value picked, at its index', async () => {
      setup(QUESTIONS_READY)
      await choose(/6 or 7/)
      const card = screen.getByTestId('intake-contradiction-geschosse_oberirdisch@bw1')
      expect(card).toHaveTextContent('Question 9 of 9 · decides the building class')
      const answer = within(card).getByRole('button', { name: 'Use and continue' })
      expect(answer).toBeDisabled()
      await userEvent.click(within(card).getByRole('radio', { name: /7/ }))
      await userEvent.click(answer)
      expect(onDecide).toHaveBeenCalledWith([{ key: 'geschosse_oberirdisch@bw1', action: 'confirm', alternativeIndex: 0 }])
    })

    it('confirms the value on the profile without an index', async () => {
      setup(QUESTIONS_READY)
      await choose(/6 or 7/)
      const card = screen.getByTestId('intake-contradiction-geschosse_oberirdisch@bw1')
      await userEvent.click(within(card).getByRole('radio', { name: /6/ }))
      await userEvent.click(within(card).getByRole('button', { name: 'Use and continue' }))
      expect(onDecide).toHaveBeenCalledWith([{ key: 'geschosse_oberirdisch@bw1', action: 'confirm' }])
    })

    it('can be put off: nothing is decided, the round goes on', async () => {
      setup(QUESTIONS_READY)
      await choose(/6 or 7/)
      await userEvent.click(screen.getByRole('button', { name: /: decide later$/ }))
      expect(onDecide).not.toHaveBeenCalled()
      expect(screen.getByTestId('intake-question-bgf_oberirdisch@bw1')).toBeInTheDocument()
    })
  })

  it('counts a question as done when it leaves the review', () => {
    const { rerender } = setup(QUESTIONS_READY)
    const answered = { ...QUESTIONS_READY, questions: QUESTIONS_READY.questions.slice(1) }
    rerender(<QuestionsStep {...props(answered)} />)
    expect(within(screen.getByTestId('questions-group-missing')).getAllByRole('listitem')[0]).toHaveTextContent('done')
    expect(screen.getByTestId('intake-question-einheiten_ueber_400@bw1')).toHaveTextContent('Question 2 of 9')
  })

  it('says the round follows the reading, and still takes answers', () => {
    setup(QUESTIONS_READING)
    expect(screen.getByTestId('questions-reading-note')).toBeInTheDocument()
    expect(screen.getByTestId('document-request-grundstueck')).toBeInTheDocument()
  })

  it('asks a past project only its Bundesland, and requests no document', () => {
    setup(QUESTIONS_CLOSING)
    expect(screen.getByTestId('questions-closing-note')).toBeInTheDocument()
    expect(screen.getByTestId('intake-question-bundesland')).toHaveTextContent('Question 1 of 1')
    expect(screen.queryByTestId('questions-group-location')).toBeNull()
  })

  it('says so when everything is settled', () => {
    setup(QUESTIONS_DONE)
    expect(screen.getByTestId('questions-done')).toHaveTextContent('All questions answered')
  })

  it('folds the optional interview away until it is opened', async () => {
    setup(QUESTIONS_READY)
    expect(screen.queryByTestId('intake-interview')).toBeNull()
    await userEvent.click(within(list()).getByRole('button', { name: /More details/ }))
    expect(await screen.findByTestId('intake-interview')).toHaveTextContent('Question 1 of 2')
  })
})
