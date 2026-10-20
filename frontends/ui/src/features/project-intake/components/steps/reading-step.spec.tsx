/**
 * Step 3, Erfassung, drawn from its fixtures: the milestones it names in each
 * state, that every number is the view's, the way out (the chat, leaving, the
 * next step), and what it leaves to the frame (the failed alert's retry).
 *
 * Carried over from the one-page setup's spec: the reading shows as a
 * determinate bar and wordless skeletons, nothing spins, no skeleton once the
 * reading is over, and a failed reading keeps what was found.
 */
import { render, screen, within } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  READING_COMPLETED,
  READING_FAILED,
  READING_QUEUED,
  READING_READY,
  READING_READY_WITH_REST,
  READING_RUNNING,
  READING_SITE_FROM_DOCUMENTS,
  READING_SITE_SEARCHING,
  READING_WAITING,
} from '@/app/dev/_fixtures/project-setup-reading'
import { I18nProvider } from '@/i18n/context'
import type { IntakeView } from '@/lib/project-intake/types'
import { ReadingStep } from './reading-step'
import type { SetupStepProps } from './types'

const onNext = vi.fn()
const onGoTo = vi.fn()
const onReread = vi.fn()

function props(view: IntakeView): SetupStepProps {
  return {
    view,
    projectId: view.projectId,
    busy: false,
    canDecide: view.canDecide,
    canUpload: true,
    uploading: false,
    onDecide: vi.fn(async () => true),
    onFiles: vi.fn(),
    onReread,
    onNext,
    onGoTo,
  }
}

const setup = (view: IntakeView) => render(<ReadingStep {...props(view)} />)
const milestone = (id: string) => screen.getByTestId(`reading-milestone-${id}`)

describe('ReadingStep', () => {
  beforeEach(() => vi.clearAllMocks())

  describe('while Piloti reads', () => {
    it('names the milestones with the view’s own numbers, in the ticket’s order', () => {
      setup(READING_RUNNING)

      const rows = within(screen.getByTestId('reading-milestones')).getAllByRole('listitem')
      expect(rows.map((row) => row.dataset.testid)).toEqual([
        'reading-milestone-site',
        'reading-milestone-documents',
        'reading-milestone-values',
        'reading-milestone-contradictions',
        'reading-milestone-gaps',
      ])
      expect(milestone('site')).toHaveTextContent('Site determined')
      expect(milestone('site')).toHaveTextContent('Wien · Lacknergasse 12, 1170 Wien · from the address search')
      expect(milestone('documents')).toHaveTextContent('9 of 23 documents read')
      expect(milestone('documents')).toHaveAttribute('data-state', 'active')
      expect(milestone('gaps')).toHaveTextContent('4 gaps')
      expect(milestone('gaps')).toHaveAttribute('data-state', 'attention')
      expect(milestone('contradictions')).toHaveTextContent('No contradictions')
    })

    it('shows reading as a determinate bar and a wordless skeleton, with nothing that spins', () => {
      const { container } = setup(READING_RUNNING)

      expect(screen.getByRole('progressbar', { name: 'Reading progress: 9 of 23 documents' })).toBeInTheDocument()
      expect(screen.getByTestId('intake-reading-skeleton')).toHaveAttribute('aria-hidden', 'true')
      expect(container.querySelector('[data-slot="spinner"]')).toBeNull()
      expect(container.querySelector('.animate-spin')).toBeNull()
    })

    it('says the person may leave and will be told, and links the project chat', () => {
      setup(READING_RUNNING)

      expect(screen.getByTestId('reading-leave')).toHaveTextContent('You can leave this page')
      expect(screen.getByTestId('reading-leave')).toHaveTextContent('We will notify you when Piloti is done.')
      expect(screen.getByRole('link', { name: 'Open the project chat and ask Piloti about the documents' })).toHaveAttribute(
        'href',
        `/app/projects/${READING_RUNNING.projectId}/chat`
      )
    })

    it('keeps the way on open, as a secondary, while it reads', async () => {
      setup(READING_RUNNING)

      const next = screen.getByRole('button', { name: 'On to the questions' })
      expect(next).toHaveAttribute('data-emphasis', 'quiet')
      await userEvent.click(next)
      expect(onNext).toHaveBeenCalledTimes(1)
    })

    it('looks for the site while no Bundesland is known', () => {
      setup(READING_SITE_SEARCHING)
      expect(milestone('site')).toHaveTextContent('Looking for the site')
      expect(milestone('site')).toHaveAttribute('data-state', 'active')
    })

    it('says a site found in the documents is still to confirm', () => {
      setup(READING_SITE_FROM_DOCUMENTS)
      expect(milestone('site')).toHaveTextContent(
        'Niederösterreich · Hauptplatz 4, 3100 St. Pölten · from the documents, still to confirm'
      )
    })
  })

  describe('before and after', () => {
    it('points back to the filing while there are no documents, and shows only the site', async () => {
      setup(READING_WAITING)

      expect(screen.getByRole('heading', { name: 'No documents yet' })).toBeInTheDocument()
      expect(within(screen.getByTestId('reading-milestones')).getAllByRole('listitem')).toHaveLength(1)
      expect(screen.queryByRole('button', { name: 'On to the questions' })).toBeNull()
      expect(screen.queryByTestId('reading-leave')).toBeNull()
      await userEvent.click(screen.getByRole('button', { name: 'Go to filing' }))
      expect(onGoTo).toHaveBeenCalledWith('filing')
    })

    it('says the documents are here and nothing is read yet while the reading is queued', () => {
      setup(READING_QUEUED)
      expect(milestone('documents')).toHaveTextContent('0 of 23 documents read')
      expect(milestone('contradictions')).toHaveAttribute('data-state', 'pending')
      expect(screen.getByTestId('reading-leave')).toBeInTheDocument()
    })

    it('shows what the reading found and its summary once it is done, and leads on', async () => {
      setup(READING_READY)

      expect(screen.getByRole('heading', { name: 'Piloti has read your documents' })).toBeInTheDocument()
      expect(milestone('documents')).toHaveTextContent('23 of 23 documents read')
      expect(milestone('contradictions')).toHaveTextContent('6 contradictions')
      expect(milestone('gaps')).toHaveTextContent('9 gaps')
      expect(screen.getByTestId('reading-summary')).toHaveTextContent('Die Geschoßanzahl ist widersprüchlich')
      expect(screen.queryByTestId('intake-reading-skeleton')).toBeNull()
      expect(screen.queryByRole('progressbar')).toBeNull()
      expect(screen.queryByTestId('reading-leave')).toBeNull()

      const next = screen.getByRole('button', { name: 'On to the questions' })
      expect(next).toHaveAttribute('data-emphasis', 'lead')
      await userEvent.click(next)
      expect(onNext).toHaveBeenCalledTimes(1)
    })

    it('says how many documents stayed unread', () => {
      setup(READING_READY_WITH_REST)
      expect(milestone('documents')).toHaveTextContent('21 of 23 documents read')
      expect(milestone('documents')).toHaveTextContent('2 documents are not read yet')
    })

    it('keeps what a failed reading found, and leaves the retry to the frame’s alert', () => {
      setup(READING_FAILED)

      expect(screen.getByRole('heading', { name: 'The reading was interrupted' })).toBeInTheDocument()
      expect(milestone('documents')).toHaveTextContent('9 of 23 documents read')
      expect(milestone('documents')).toHaveAttribute('data-state', 'done')
      expect(screen.queryByRole('button', { name: /Read again|Start reading again/ })).toBeNull()
      expect(onReread).not.toHaveBeenCalled()
      expect(screen.queryByTestId('intake-reading-skeleton')).toBeNull()
    })

    it('shows a finished setup with its summary', () => {
      setup(READING_COMPLETED)
      expect(screen.getByRole('heading', { name: 'The setup is finished' })).toBeInTheDocument()
      expect(screen.getByTestId('reading-summary')).toBeInTheDocument()
    })
  })

  it('speaks German first', () => {
    render(
      <I18nProvider initialLocale="de" fixedLocale>
        <ReadingStep {...props(READING_RUNNING)} />
      </I18nProvider>
    )

    expect(screen.getByRole('heading', { name: 'Piloti liest Ihre Unterlagen' })).toBeInTheDocument()
    expect(milestone('site')).toHaveTextContent('Standort ermittelt')
    expect(milestone('documents')).toHaveTextContent('9 von 23 Dokumenten gelesen')
    expect(milestone('gaps')).toHaveTextContent('4 Lücken')
    expect(screen.getByTestId('reading-leave')).toHaveTextContent(
      'Sie können diese Seite verlassen'
    )
    expect(screen.getByRole('link', { name: /Projekt-Chat/ })).toHaveTextContent('Im Chat fragen')
  })
})
