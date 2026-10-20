/**
 * Step 3, Erfassung, drawn from its fixtures inside the frame's footer: the
 * documents bar and the milestones it names in each state, that every number
 * is the view's, the values found with their page, the way out (the chat, the
 * footer's one primary action), reading what is unread and adding documents,
 * and what it leaves to the frame (the failed alert's retry).
 *
 * Carried over: the reading shows as a determinate bar, nothing spins, and a
 * failed reading keeps what was found.
 */
import { render, screen, within } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
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
import { SetupFooter, StepFooterProvider, useStepFooterChannel } from '../setup-frame'
import { ReadingStep } from './reading-step'
import type { SetupStepProps } from './types'

// The project's own upload, drawn hidden behind „Dokumente hinzufügen".
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

const onNext = vi.fn()
const onGoTo = vi.fn()
const onReread = vi.fn()

function props(view: IntakeView, overrides: Partial<SetupStepProps> = {}): SetupStepProps {
  return {
    view,
    projectId: view.projectId,
    busy: false,
    canDecide: view.canDecide && view.status !== 'completed',
    canUpload: view.status !== 'completed',
    uploading: false,
    onDecide: vi.fn(async () => true),
    onFiles: vi.fn(),
    onReread,
    onNext,
    onGoTo,
    ...overrides,
  }
}

function Framed({ children }: { children: ReactNode }) {
  const { channel, progress, ownsPrimary, slotRef } = useStepFooterChannel()
  return (
    <StepFooterProvider value={channel}>
      {children}
      <SetupFooter step="reading" progress={progress} ownsPrimary={ownsPrimary} slotRef={slotRef} onNext={onNext} />
    </StepFooterProvider>
  )
}

const setup = (view: IntakeView, overrides: Partial<SetupStepProps> = {}) =>
  render(
    <Framed>
      <ReadingStep {...props(view, overrides)} />
    </Framed>
  )
const milestone = (id: string) => screen.getByTestId(`reading-milestone-${id}`)
const footer = () => within(screen.getByTestId('intake-setup-footer'))

describe('ReadingStep', () => {
  beforeEach(() => vi.clearAllMocks())

  describe('while Piloti reads', () => {
    it('shows the documents as a bar and the milestones with the view’s own numbers', () => {
      setup(READING_RUNNING)

      expect(screen.getByRole('heading', { level: 1, name: 'Piloti is reading your documents' })).toBeInTheDocument()
      expect(screen.getByRole('progressbar', { name: '9 of 23 documents read' })).toBeInTheDocument()
      expect(screen.getByTestId('reading-documents')).toHaveTextContent('9 of 23 read')
      const rows = within(screen.getByTestId('reading-milestones')).getAllByRole('listitem')
      expect(rows.map((row) => row.dataset.testid)).toEqual([
        'reading-milestone-site',
        'reading-milestone-values',
        'reading-milestone-contradictions',
        'reading-milestone-gaps',
      ])
      expect(milestone('site')).toHaveTextContent('Site determined')
      expect(milestone('site')).toHaveTextContent('Wien')
      expect(milestone('values')).toHaveTextContent(/^Values found \(done\)3$/)
      expect(milestone('contradictions')).toHaveTextContent('none so far')
      expect(milestone('gaps')).toHaveTextContent('after the reading')
      expect(milestone('gaps')).toHaveAttribute('data-state', 'pending')
    })

    it('shows what it found so far, each value with its document and page', () => {
      setup(READING_RUNNING)

      const feed = screen.getByTestId('reading-found')
      expect(within(feed).getByRole('heading', { name: 'Found so far' })).toBeInTheDocument()
      const rows = within(feed).getAllByTestId('reading-found-value')
      expect(rows).toHaveLength(3)
      expect(feed).toHaveTextContent('Bescheid, p. 1')
      expect(feed).not.toHaveTextContent('.pdf')
    })

    it('calls a value that arrives while the page is open just found, and puts it first', () => {
      const { rerender } = setup(READING_RUNNING)
      const extra = READING_READY.groups.flatMap((group) => group.items).find((item) => item.key.startsWith('escape_level'))
      expect(extra).toBeDefined()
      const next: IntakeView = {
        ...READING_RUNNING,
        groups: [...READING_RUNNING.groups, { stage: 'x', title: 'x', items: extra ? [extra] : [] }],
      }
      rerender(
        <Framed>
          <ReadingStep {...props(next)} />
        </Framed>
      )

      const feed = screen.getByTestId('reading-found')
      expect(within(feed).getByRole('heading', { name: 'Just found' })).toBeInTheDocument()
      expect(within(feed).getAllByTestId('reading-found-value')[0]).toHaveAttribute('data-fresh', 'true')
    })

    it('draws a determinate bar and nothing that spins', () => {
      const { container } = setup(READING_RUNNING)
      expect(container.querySelector('[data-slot="spinner"]')).toBeNull()
      expect(container.querySelector('.animate-spin')).toBeNull()
    })

    it('says the person need not wait, and links the project chat', () => {
      setup(READING_RUNNING)

      expect(screen.getByTestId('reading-band')).toHaveTextContent('You do not have to wait. Piloti lets you know when it is done.')
      const chat = screen.getByRole('link', { name: 'Open the project chat and ask Piloti about the documents' })
      expect(chat).toHaveAttribute('href', `/app/projects/${READING_RUNNING.projectId}/chat`)
      expect(chat).toHaveTextContent('Ask in the chat now')
    })

    it('leads on to the questions from the footer, the only primary action', async () => {
      setup(READING_RUNNING)

      expect(within(screen.getByTestId('setup-step-reading')).queryByRole('button', { name: 'On to the questions' })).toBeNull()
      await userEvent.click(footer().getByRole('button', { name: 'On to the questions' }))
      expect(onNext).toHaveBeenCalledTimes(1)
    })

    it('offers adding documents quietly in the footer, and nothing to read while it reads', () => {
      setup(READING_RUNNING)
      expect(footer().getAllByRole('button', { name: 'Add documents' }).length).toBeGreaterThan(0)
      expect(screen.queryByTestId('reading-unread')).toBeNull()
    })

    it('looks for the site while no Bundesland is known', () => {
      setup(READING_SITE_SEARCHING)
      expect(milestone('site')).toHaveTextContent('Looking for the site')
      expect(milestone('site')).toHaveAttribute('data-state', 'active')
    })

    it('says a site found in the documents is still to confirm', () => {
      setup(READING_SITE_FROM_DOCUMENTS)
      expect(milestone('site')).toHaveTextContent('Site found')
      expect(milestone('site')).toHaveTextContent('Niederösterreich · to confirm')
    })
  })

  describe('before and after', () => {
    it('points back to the filing while there are no documents, and lets the person go on without', async () => {
      setup(READING_WAITING)

      expect(screen.getByRole('heading', { name: 'No documents yet' })).toBeInTheDocument()
      expect(within(screen.getByTestId('reading-milestones')).getAllByRole('listitem')).toHaveLength(1)
      expect(screen.queryByTestId('reading-documents')).toBeNull()
      expect(screen.queryByRole('button', { name: 'On to the questions' })).toBeNull()
      await userEvent.click(footer().getByRole('button', { name: 'Go to filing' }))
      expect(onGoTo).toHaveBeenCalledWith('filing')
      await userEvent.click(footer().getAllByRole('button', { name: 'Continue without documents' })[0])
      expect(onNext).toHaveBeenCalledTimes(1)
    })

    it('says the documents are here and nothing is read yet while the reading is queued', () => {
      setup(READING_QUEUED)
      expect(screen.getByTestId('reading-documents')).toHaveTextContent('0 of 23 read')
      expect(milestone('contradictions')).toHaveAttribute('data-state', 'pending')
      expect(screen.getByTestId('reading-band')).toHaveTextContent('You do not have to wait.')
    })

    it('shows what the reading found once it is done, with the summary folded', async () => {
      setup(READING_READY)

      expect(screen.getByRole('heading', { name: 'Piloti has read your documents' })).toBeInTheDocument()
      expect(screen.getByTestId('reading-documents')).toHaveTextContent('23 of 23 read')
      expect(milestone('contradictions')).toHaveTextContent(/Contradictions \(needs you\)6$/)
      expect(milestone('contradictions')).toHaveAttribute('data-state', 'attention')
      expect(milestone('gaps')).toHaveTextContent('9')
      expect(screen.getByRole('heading', { name: 'Found, among others' })).toBeInTheDocument()
      expect(screen.getByTestId('reading-band')).not.toHaveTextContent('You do not have to wait')

      expect(screen.queryByText(/Die Geschoßanzahl ist widersprüchlich/)).toBeNull()
      await userEvent.click(screen.getByRole('button', { name: 'What Piloti says about it' }))
      expect(screen.getByTestId('reading-summary')).toHaveTextContent('Die Geschoßanzahl ist widersprüchlich')
    })

    it('links every value found to the Steckbrief', async () => {
      setup(READING_READY)
      await userEvent.click(screen.getByRole('button', { name: /All \d+ in the profile/ }))
      expect(onGoTo).toHaveBeenCalledWith('profile')
    })

    it('says how many documents stayed unread, and reads them on request', async () => {
      setup(READING_READY_WITH_REST)

      expect(screen.getByTestId('reading-documents')).toHaveTextContent('21 of 23 read')
      expect(screen.getByTestId('reading-unread')).toHaveTextContent('2 documents not read yet')
      await userEvent.click(screen.getByRole('button', { name: 'Read the 2 documents that are not read yet' }))
      expect(onReread).toHaveBeenCalledTimes(1)
    })

    it('does not offer reading to a person who may not decide', () => {
      setup(READING_READY_WITH_REST, { canDecide: false })
      expect(screen.getByTestId('reading-unread')).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: /Read the/ })).toBeNull()
    })

    it('keeps what a failed reading found, and offers another reading as the one action', async () => {
      setup(READING_FAILED)

      expect(screen.getByRole('heading', { name: 'Piloti stopped reading' })).toBeInTheDocument()
      expect(screen.getByTestId('reading-documents')).toHaveTextContent('9 of 23 read')
      expect(milestone('values')).toHaveAttribute('data-state', 'done')
      expect(screen.queryByTestId('reading-unread')).toBeNull()
      expect(screen.getAllByRole('button', { name: 'On to the questions anyway' }).length).toBeGreaterThan(0)
      await userEvent.click(screen.getByRole('button', { name: 'Read again' }))
      expect(onReread).toHaveBeenCalledTimes(1)
    })

    it('offers a reader who may not decide no retry after a failed reading', () => {
      setup(READING_FAILED, { canDecide: false })
      expect(screen.queryByRole('button', { name: 'Read again' })).toBeNull()
    })

    it('shows a finished setup without a way to add documents', () => {
      setup(READING_COMPLETED)
      expect(screen.getByRole('heading', { name: 'Piloti has read your documents' })).toBeInTheDocument()
      expect(milestone('gaps')).toHaveTextContent('none')
      expect(screen.queryByRole('button', { name: 'Add documents' })).toBeNull()
      expect(screen.getByTestId('reading-summary')).toBeInTheDocument()
    })
  })

  it('speaks German first', () => {
    render(
      <I18nProvider initialLocale="de" fixedLocale>
        <Framed>
          <ReadingStep {...props(READING_RUNNING)} />
        </Framed>
      </I18nProvider>
    )

    expect(screen.getByRole('heading', { name: 'Piloti liest Ihre Unterlagen' })).toBeInTheDocument()
    expect(screen.getByTestId('reading-documents')).toHaveTextContent('9 von 23 gelesen')
    expect(milestone('site')).toHaveTextContent('Standort ermittelt')
    expect(milestone('gaps')).toHaveTextContent(/^Lücken, die die Gebäudeklasse entscheiden \(noch nicht\)nach dem Lesen$/)
    expect(screen.getByTestId('reading-band')).toHaveTextContent('Sie müssen nicht warten. Piloti meldet sich, wenn es fertig ist.')
    expect(screen.getByRole('link', { name: /Projekt-Chat/ })).toHaveTextContent('Schon jetzt im Chat fragen')
    expect(footer().getByRole('button', { name: 'Weiter zu den Rückfragen' })).toBeInTheDocument()
  })
})
