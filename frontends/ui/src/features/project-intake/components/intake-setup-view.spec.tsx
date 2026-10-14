/**
 * The setup page drawn from the review fixtures: what each state shows, and
 * the exact decisions each control sends.
 */
import { fireEvent, render, screen, within } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  INTAKE_CLOSING,
  INTAKE_COMPLETED,
  INTAKE_FIXTURES,
  INTAKE_READING,
  INTAKE_READY,
  INTAKE_WAITING,
} from '@/app/dev/_fixtures/project-intake'
import type { IntakeView } from '@/lib/project-intake/types'
import { IntakeSetupView, type IntakeSetupViewProps } from './intake-setup-view'

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
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }))

const onDecide = vi.fn()
const onFiles = vi.fn()
const onReread = vi.fn()
const onComplete = vi.fn()
const onRetry = vi.fn()

function setup(view: IntakeView, props: Partial<IntakeSetupViewProps> = {}) {
  return render(
    <IntakeSetupView
      view={view}
      projectId={view.projectId}
      busy={false}
      stale={false}
      canUpload
      uploading={false}
      onFiles={onFiles}
      onDecide={onDecide}
      onReread={onReread}
      onComplete={onComplete}
      onRetry={onRetry}
      {...props}
    />
  )
}

describe('IntakeSetupView', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    onDecide.mockResolvedValue(true)
    onComplete.mockResolvedValue(true)
  })

  describe('states', () => {
    it('waits for documents with the drop zone, no review and nothing to read', () => {
      setup(INTAKE_WAITING)

      expect(screen.getByText('Waiting for documents')).toBeInTheDocument()
      expect(screen.getByTestId('intake-upload-zone')).toHaveTextContent('Drop the project folder')
      expect(screen.queryByTestId('intake-review')).toBeNull()
      expect(screen.queryByRole('button', { name: /Read the documents that have not been read yet/ })).toBeNull()
    })

    it('says Piloti is reading, with the counts so far, and no drop zone', () => {
      setup(INTAKE_READING)

      expect(screen.getByText('Piloti is reading the documents …')).toBeInTheDocument()
      expect(screen.getByTestId('intake-status-line')).toHaveTextContent('9 documents read · 6 values · 0 contradictions · 0 questions')
      expect(screen.queryByTestId('intake-upload-zone')).toBeNull()
      expect(screen.getByRole('button', { name: /Read the documents that have not been read yet/ })).toBeDisabled()
    })

    it('shows the review in order: contradictions, questions, review, derivations, finish', () => {
      setup(INTAKE_READY)

      expect(screen.getByTestId('intake-status-line')).toHaveTextContent('23 documents read · 41 values · 1 contradiction · 3 questions')
      const order = ['intake-contradictions', 'intake-questions', 'intake-review', 'intake-derivations', 'intake-complete']
      const nodes = order.map((id) => screen.getByTestId(id))
      nodes.slice(1).forEach((node, index) => {
        expect(nodes[index].compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
      })
    })

    it('marks a decisive row, a confirmed one and a contested one in words', () => {
      setup(INTAKE_READY)

      const row = screen.getByTestId('intake-suggestion-fluchtniveau_m@bw1')
      expect(row).toHaveTextContent('Decisive')
      expect(screen.getByTestId('intake-suggestion-standort_adresse')).toHaveTextContent('Confirmed')
      expect(screen.getByTestId('intake-suggestion-geschosse_oberirdisch@bw1')).toHaveTextContent('Contradiction')
    })

    it('shows the Gebäudeklasse of a Bauwerk with its inputs, and „still open“ with what is missing', () => {
      setup(INTAKE_READY)

      const done = screen.getByTestId('intake-derivation-bw1')
      expect(done).toHaveTextContent('GK 5')
      expect(done).toHaveTextContent('Anzahl oberirdischer Geschoße (Zielzustand): 6 · suggested')
      expect(done).toHaveTextContent('Gebäudestellung: angebaut')
      expect(done).not.toHaveTextContent('Gebäudestellung: angebaut · suggested')
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

    it('says the reading failed, and offers another', () => {
      setup({ ...INTAKE_READY, status: 'failed' })
      expect(screen.getByText('Piloti could not finish reading. You can try again.')).toBeInTheDocument()
    })

    it('offers to retry when the last refresh failed', async () => {
      setup(INTAKE_READY, { stale: true })
      await userEvent.click(screen.getByRole('button', { name: 'Try again' }))
      expect(onRetry).toHaveBeenCalledTimes(1)
    })

    it('shows a finished setup read-only, with the way to the project', () => {
      setup(INTAKE_COMPLETED)

      expect(screen.getByTestId('intake-completed')).toHaveTextContent('The setup is finished.')
      expect(screen.getByRole('link', { name: 'To the project' })).toHaveAttribute('href', `/app/projects/${INTAKE_COMPLETED.projectId}`)
      expect(screen.queryByRole('button', { name: /Use/ })).toBeNull()
      expect(screen.queryByRole('button', { name: 'Use all' })).toBeNull()
      expect(screen.queryByRole('button', { name: 'Add documents' })).toBeNull()
      expect(screen.queryByRole('link', { name: /Open the briefing wizard/ })).toBeNull()
    })

    it('shows a reader who may not decide the review with no controls and says why', () => {
      setup({ ...INTAKE_READY, canDecide: false, canComplete: false })

      expect(screen.getByText('You can look at the setup, not change it.')).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: /^Use$/ })).toBeNull()
      expect(screen.queryByRole('button', { name: 'Use all' })).toBeNull()
      for (const control of screen.getAllByRole('button', { name: /^Use .* for / })) expect(control).toBeDisabled()
      expect(screen.queryByTestId('intake-complete')).toBeNull()
      expect(screen.queryByRole('button', { name: /Read the documents/ })).toBeNull()
    })

    it('offers no documents on a closed project', () => {
      setup(INTAKE_WAITING, { canUpload: false })
      expect(screen.queryByTestId('intake-upload-zone')).toBeNull()
      expect(screen.queryByRole('button', { name: 'Add documents' })).toBeNull()
    })

    it('links the wizard, which stays the way to fill the same profile', () => {
      setup(INTAKE_READY)
      expect(screen.getByRole('link', { name: /Open the briefing wizard/ })).toHaveAttribute(
        'href',
        `/app/projects/${INTAKE_READY.projectId}/intake`
      )
    })
  })

  describe('evidence', () => {
    it('names the file and the page, and shows the quote on hover', async () => {
      setup(INTAKE_READY)
      const contradictions = screen.getByTestId('intake-contradictions')

      const chip = within(contradictions).getByRole('button', { name: /Baubeschreibung\.pdf, p\. 3/ })
      expect(chip).toHaveTextContent('Baubeschreibung.pdf, p. 3')
      await userEvent.hover(chip)

      expect(await screen.findByText(/insgesamt sechs oberirdische Geschoße/)).toBeInTheDocument()
    })

    it('says a spreadsheet\'s source without a page', () => {
      setup(INTAKE_READY)
      expect(screen.getByTestId('intake-suggestion-nutzungseinheiten@bw1')).toHaveTextContent('Wohnungsliste.xlsx')
      expect(screen.getByTestId('intake-suggestion-nutzungseinheiten@bw1')).not.toHaveTextContent('Wohnungsliste.xlsx, p.')
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
      expect(onDecide).toHaveBeenCalledWith([
        { key: 'geschosse_oberirdisch@bw1', action: 'confirm', alternativeIndex: 0 },
      ])
    })

    it('discards an alternative, and offers no discard for the profile\'s own value', async () => {
      setup(INTAKE_READY)
      expect(screen.getAllByRole('button', { name: /Discard .* for Anzahl oberirdischer Geschoße/ })).toHaveLength(1)
      await userEvent.click(screen.getByRole('button', { name: /Discard 7 for Anzahl oberirdischer Geschoße/ }))
      expect(onDecide).toHaveBeenCalledWith([
        { key: 'geschosse_oberirdisch@bw1', action: 'dismiss', alternativeIndex: 0 },
      ])
    })

    it('answers a Rückfrage with the typed number, only once there is one', async () => {
      setup(INTAKE_READY)
      const card = screen.getByTestId('intake-question-bgf_oberirdisch@bw1')
      const answer = within(card).getByRole('button', { name: /Use this answer for Brutto-Grundfläche/ })
      expect(answer).toBeDisabled()

      await userEvent.type(within(card).getByRole('spinbutton'), '1250')
      expect(answer).toBeEnabled()
      await userEvent.click(answer)

      expect(onDecide).toHaveBeenCalledWith([{ key: 'bgf_oberirdisch@bw1', action: 'answer', value: 1250 }])
    })

    it('answers a yes/no Rückfrage with a boolean', async () => {
      setup(INTAKE_READY)
      const card = screen.getByTestId('intake-question-einheiten_ueber_400@bw1')

      await userEvent.click(within(card).getByRole('button', { name: 'No' }))
      await userEvent.click(within(card).getByRole('button', { name: /Use this answer/ }))

      expect(onDecide).toHaveBeenCalledWith([{ key: 'einheiten_ueber_400@bw1', action: 'answer', value: false }])
    })

    it('answers a select Rückfrage with the option\'s token', async () => {
      setup(INTAKE_READY)
      const card = screen.getByTestId('intake-question-gebaeudestellung@bw1')

      await userEvent.click(within(card).getByRole('combobox'))
      await userEvent.click(await screen.findByRole('option', { name: 'Reihenhaus' }))
      await userEvent.click(within(card).getByRole('button', { name: /Use this answer/ }))

      expect(onDecide).toHaveBeenCalledWith([{ key: 'gebaeudestellung@bw1', action: 'answer', value: 'reihenhaus' }])
    })

    it('says why Piloti asks and where the answer is usually found', async () => {
      setup(INTAKE_READY)
      const card = screen.getByTestId('intake-question-bgf_oberirdisch@bw1')

      expect(card).toHaveTextContent('Usually found in: Einreichplan (Plankopf), Baubeschreibung')
      await userEvent.click(within(card).getByRole('button', { name: /why/i }))
      expect(card).toHaveTextContent('Die Fläche entscheidet bei Gebäuden')
    })

    it('records „Nicht bekannt“ as unknown', async () => {
      setup(INTAKE_READY)
      await userEvent.click(screen.getByRole('button', { name: /^Brutto-Grundfläche.*: not known/ }))
      expect(onDecide).toHaveBeenCalledWith([{ key: 'bgf_oberirdisch@bw1', action: 'unknown' }])
    })

    it('hands a document in on a Rückfrage by choosing it', async () => {
      setup(INTAKE_READY)
      const card = screen.getByTestId('intake-question-bgf_oberirdisch@bw1')
      const file = new File(['%PDF'], 'Flaechenaufstellung.pdf', { type: 'application/pdf' })

      fireEvent.change(within(card).getByTestId('document-hand-in-input'), { target: { files: [file] } })

      expect(onFiles).toHaveBeenCalledWith([file])
    })

    it('hands a document in on a Rückfrage by dropping it there', () => {
      setup(INTAKE_READY)
      const card = screen.getByTestId('intake-question-bgf_oberirdisch@bw1')
      const file = new File(['%PDF'], 'Flaechenaufstellung.pdf', { type: 'application/pdf' })

      fireEvent.drop(within(card).getByTestId('document-hand-in'), {
        dataTransfer: { types: ['Files'], files: [file], items: [] },
      })

      return vi.waitFor(() => expect(onFiles).toHaveBeenCalledWith([file]))
    })

    it('confirms and dismisses one suggestion', async () => {
      setup(INTAKE_READY)
      await userEvent.click(screen.getByRole('button', { name: /Use 2023 for OIB-Ausgabe/ }))
      expect(onDecide).toHaveBeenLastCalledWith([{ key: 'oib_ausgabe', action: 'confirm' }])

      await userEvent.click(screen.getByRole('button', { name: /Discard 2023 for OIB-Ausgabe/ }))
      expect(onDecide).toHaveBeenLastCalledWith([{ key: 'oib_ausgabe', action: 'dismiss' }])
    })

    it('„Alle übernehmen“ confirms the group\'s suggestions in one call, not the confirmed or contested ones', async () => {
      setup(INTAKE_READY)

      await userEvent.click(screen.getByRole('button', { name: 'Use all 5 suggestions in Bauwerke' }))

      expect(onDecide).toHaveBeenCalledTimes(1)
      expect(onDecide).toHaveBeenCalledWith([
        { key: 'bauwerkstyp@bw1', action: 'confirm' },
        { key: 'fluchtniveau_m@bw1', action: 'confirm' },
        { key: 'gebaeudestellung@bw1', action: 'confirm' },
        { key: 'nutzungseinheiten@bw1', action: 'confirm' },
        { key: 'gebaeudeklasse@bw1', action: 'confirm' },
      ])
    })

    it('confirms the Gebäudeklasse through the suggestion row of its key', async () => {
      setup(INTAKE_READY)
      await userEvent.click(screen.getByRole('button', { name: /Use Gebäudeklasse GK 5 for Building 1/ }))
      expect(onDecide).toHaveBeenCalledWith([{ key: 'gebaeudeklasse@bw1', action: 'confirm' }])
    })

    it('holds every control while a call is in flight', () => {
      setup(INTAKE_READY, { busy: true })
      expect(screen.getByRole('button', { name: /Use 6 for Anzahl/ })).toBeDisabled()
      expect(screen.getByRole('button', { name: /Use all 5/ })).toBeDisabled()
      expect(screen.getByRole('button', { name: 'Finish setup' })).toBeDisabled()
    })

    it('starts a reading of what is new', async () => {
      setup(INTAKE_READY)
      await userEvent.click(screen.getByRole('button', { name: /Read the documents that have not been read yet/ }))
      expect(onReread).toHaveBeenCalledTimes(1)
    })
  })

  describe('finishing', () => {
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

    it('says so when the project is closed, in a closed review', () => {
      setup({ ...INTAKE_COMPLETED, mode: 'closing', closing: INTAKE_CLOSING.closing })
      expect(screen.getByTestId('intake-completed')).toHaveTextContent('closed')
    })

    it('offers no finish to a reader who may not', () => {
      setup({ ...INTAKE_READY, canComplete: false })
      expect(screen.queryByRole('button', { name: 'Finish setup' })).toBeNull()
    })
  })

  describe('drops', () => {
    it('files a folder dropped anywhere on the page', async () => {
      setup(INTAKE_READY)
      const file = new File(['%PDF'], 'EG.pdf', { type: 'application/pdf' })

      fireEvent.drop(screen.getByTestId('intake-setup'), { dataTransfer: { types: ['Files'], files: [file], items: [] } })

      await vi.waitFor(() => expect(onFiles).toHaveBeenCalledWith([file]))
    })

    it('takes no drop on a finished setup', () => {
      setup(INTAKE_COMPLETED)
      const file = new File(['%PDF'], 'EG.pdf', { type: 'application/pdf' })

      fireEvent.drop(screen.getByTestId('intake-setup'), { dataTransfer: { types: ['Files'], files: [file], items: [] } })

      expect(onFiles).not.toHaveBeenCalled()
    })
  })

  it('has a fixture for every state', () => {
    expect(Object.keys(INTAKE_FIXTURES).sort()).toEqual(['closing', 'completed', 'reading', 'ready', 'waiting'])
  })
})
