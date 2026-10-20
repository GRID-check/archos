/**
 * The setup page's frame: which step it opens on, that the step lives in the
 * address, the stepper's notes, the drop on every step, and the notices above
 * the step. The five step organisms are stubbed: each owns its content and its
 * specs; here they only show the props the frame hands them.
 */
import { act, fireEvent, render, screen, within } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  INTAKE_CLOSING,
  INTAKE_COMPLETED,
  INTAKE_FAILED,
  INTAKE_FIXTURES,
  INTAKE_READING,
  INTAKE_READY,
  INTAKE_WAITING,
} from '@/app/dev/_fixtures/project-intake'
import type { IntakeView } from '@/lib/project-intake/types'
import { defaultSetupStep, IntakeSetupView, type IntakeSetupViewProps } from './intake-setup-view'
import { QUESTIONS_READY } from '@/app/dev/_fixtures/project-setup-questions'
import type { SetupStepId, SetupStepProps } from './steps/types'
import { StepFooter } from './setup-frame'

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

// Next's router follows `history.pushState` into `useSearchParams`; this does
// the same from the address jsdom keeps, so a step written there is read back.
const address = vi.hoisted(() => {
  const listeners = new Set<() => void>()
  return {
    listeners,
    notify: () => {
      for (const listener of listeners) listener()
    },
  }
})
vi.mock('next/navigation', async () => {
  const { useSyncExternalStore } = await import('react')
  return {
    useRouter: () => ({ push: vi.fn() }),
    usePathname: () => window.location.pathname,
    useSearchParams: () => {
      const search = useSyncExternalStore(
        (listener) => {
          address.listeners.add(listener)
          return () => address.listeners.delete(listener)
        },
        () => window.location.search
      )
      return new URLSearchParams(search)
    },
  }
})

// Each step as a stub that names itself and the props the frame gave it.
vi.mock('./steps/project-step', () => ({ ProjectStep: (props: SetupStepProps) => <StubStep id="project" {...props} /> }))
vi.mock('./steps/filing-step', () => ({
  FilingStep: (props: SetupStepProps & { children?: React.ReactNode; filing?: unknown }) => (
    <StubStep id="filing" {...props}>
      {props.filing ? <p>filing given</p> : null}
      {props.children}
    </StubStep>
  ),
}))
vi.mock('./steps/reading-step', () => ({ ReadingStep: (props: SetupStepProps) => <StubStep id="reading" {...props} /> }))
vi.mock('./steps/questions-step', () => ({ QuestionsStep: (props: SetupStepProps) => <StubStep id="questions" {...props} /> }))
vi.mock('./steps/profile-step', () => ({
  ProfileStep: (props: SetupStepProps & { onComplete: () => Promise<boolean> }) => (
    <StubStep id="profile" {...props}>
      <StepFooter
        primary={
          <button type="button" onClick={() => void props.onComplete()}>
            stub complete
          </button>
        }
        aside={<button type="button">stub aside</button>}
        progress={{ done: 1, total: 6, label: '1 of 6 done' }}
      />
    </StubStep>
  ),
}))

function StubStep({ id, children, ...props }: SetupStepProps & { id: SetupStepId; children?: React.ReactNode }) {
  return (
    <section
      data-testid={`setup-step-${id}`}
      data-can-decide={String(props.canDecide)}
      data-can-upload={String(props.canUpload)}
      data-busy={String(props.busy)}
    >
      {props.onNext && (
        <button type="button" onClick={props.onNext}>
          stub next
        </button>
      )}
      <button type="button" onClick={() => props.onGoTo('questions')}>
        stub to questions
      </button>
      {children}
    </section>
  )
}

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
      projectName="Wohnanlage Gartenstraße 12"
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

/** Open the page at an address, as a link or a reload would. */
function at(search: string): void {
  window.history.replaceState(null, '', `/app/projects/p1/setup${search}`)
}

const shown = (): string | null => screen.getByTestId('intake-setup').getAttribute('data-step')
const rail = () => screen.getByRole('navigation', { name: 'Steps of the setup' })
const stepButton = (name: RegExp) => within(rail()).getByRole('button', { name })

describe('IntakeSetupView', () => {
  let pushState: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    onDecide.mockResolvedValue(true)
    onComplete.mockResolvedValue(true)
    at('')
    const push = window.history.pushState.bind(window.history)
    pushState = vi.spyOn(window.history, 'pushState').mockImplementation((...args) => {
      push(...args)
      address.notify()
    })
  })

  afterEach(() => {
    pushState.mockRestore()
  })

  describe('which step it opens on', () => {
    it.each<[string, IntakeView, SetupStepId]>([
      ['no documents yet', INTAKE_WAITING, 'filing'],
      ['a reading that has found something', INTAKE_READING, 'profile'],
      ['decisive questions open', INTAKE_READY, 'questions'],
      ['nothing left to ask', INTAKE_CLOSING, 'profile'],
      ['a finished setup', INTAKE_COMPLETED, 'profile'],
    ])('%s', (_, view, step) => {
      expect(defaultSetupStep(view)).toBe(step)
      setup(view)
      expect(shown()).toBe(step)
      expect(screen.getByTestId(`setup-step-${step}`)).toBeInTheDocument()
    })

    it('opens on the reading while it has found nothing yet, and while a reading that found nothing failed', () => {
      const nothing = { counts: { ...INTAKE_READING.counts, suggested: 0 }, groups: [] }
      expect(defaultSetupStep({ ...INTAKE_READING, ...nothing })).toBe('reading')
      expect(defaultSetupStep({ ...INTAKE_FAILED, ...nothing })).toBe('reading')
      // Documents are in and the first reading has not begun.
      expect(defaultSetupStep({ ...INTAKE_WAITING, counts: { ...INTAKE_WAITING.counts, unreadDocuments: 4 }, groups: [] })).toBe(
        'reading'
      )
    })

    it('opens on the Rückfragen when only a location document is missing, and counts it in the stepper', () => {
      // Nothing decisive is open, but the register still asks for the Grundbuchauszug.
      const view = { ...QUESTIONS_READY, contradictions: [], questions: [] }
      expect(defaultSetupStep(view)).toBe('questions')
      expect(defaultSetupStep({ ...view, locationRegister: undefined })).toBe('profile')
    })

    it('stays on its step while the reading changes the view underneath', () => {
      const { rerender } = setup(INTAKE_WAITING)
      expect(shown()).toBe('filing')
      rerender(
        <IntakeSetupView
          view={INTAKE_READY}
          projectId={INTAKE_READY.projectId}
          busy={false}
          stale={false}
          canUpload
          uploading={false}
          onFiles={onFiles}
          onDecide={onDecide}
          onReread={onReread}
          onComplete={onComplete}
          onRetry={onRetry}
        />
      )
      expect(shown()).toBe('filing')
    })
  })

  describe('the step in the address', () => {
    it('opens the step the address names, whatever the default', () => {
      at('?step=project')
      setup(INTAKE_READY)
      expect(shown()).toBe('project')
    })

    it('ignores a step it does not know', () => {
      at('?step=documents')
      setup(INTAKE_READY)
      expect(shown()).toBe('questions')
    })

    it('writes the chosen step into the address, keeps the rest, and drops the create dialog’s handover', async () => {
      at('?drop=new-project:abc&from=inbox')
      setup(INTAKE_READY)

      await userEvent.click(stepButton(/^2\. Filing/))

      expect(shown()).toBe('filing')
      const params = new URLSearchParams(window.location.search)
      expect(params.get('step')).toBe('filing')
      expect(params.get('from')).toBe('inbox')
      expect(params.get('drop')).toBeNull()
      // A new history entry, so back returns to the step before.
      expect(pushState).toHaveBeenCalledTimes(1)
    })

    it('follows back and forward', async () => {
      setup(INTAKE_READY)
      await userEvent.click(stepButton(/^5\. Profile/))
      expect(shown()).toBe('profile')

      // Back to the entry without a step: the step it opened on.
      act(() => {
        window.history.replaceState(null, '', '/app/projects/p1/setup')
        address.notify()
      })
      expect(shown()).toBe('questions')
    })

    it('scrolls to the top when the step changes, not on the first paint', async () => {
      const scroll = vi.fn()
      const before = Element.prototype.scrollTo
      Element.prototype.scrollTo = scroll
      try {
        setup(INTAKE_READY)
        expect(scroll).not.toHaveBeenCalled()

        await userEvent.click(screen.getByRole('button', { name: 'stub next' }))
        expect(shown()).toBe('profile')
        expect(scroll).toHaveBeenCalledWith({ top: 0 })
      } finally {
        Element.prototype.scrollTo = before
      }
    })

    it('does not push a step that is already shown', async () => {
      setup(INTAKE_READY)
      await userEvent.click(stepButton(/^4\. Questions/))
      expect(pushState).not.toHaveBeenCalled()
    })
  })

  describe('the stepper', () => {
    it('names the five steps, all of them reachable, with a note on each that has one', () => {
      setup(INTAKE_READY)
      const names = within(rail())
        .getAllByRole('button')
        .map((button) => button.getAttribute('aria-label'))
      expect(names).toEqual([
        '1. Project',
        '2. Filing — 23 documents',
        '3. Reading — 23 read',
        '4. Questions — 3 open',
        '5. Profile — 1 contradiction',
      ])
      for (const button of within(rail()).getAllByRole('button')) expect(button).toBeEnabled()
      expect(within(screen.getByTestId('intake-setup-footer')).getByText('Step 4 of 5')).toBeInTheDocument()
    })

    it('says how far the reading is while it runs, and that a failed one was interrupted', () => {
      const { unmount } = setup(INTAKE_READING)
      expect(stepButton(/^3\. Reading/)).toHaveAccessibleName('3. Reading — 9 of 23')
      unmount()
      setup(INTAKE_FAILED)
      expect(stepButton(/^3\. Reading/)).toHaveAccessibleName('3. Reading — interrupted')
    })

    it('says a finished setup is finished', () => {
      setup(INTAKE_COMPLETED)
      expect(stepButton(/^5\. Profile/)).toHaveAccessibleName('5. Profile — finished')
    })

    it('gives each step its way on, and none on the last', async () => {
      at('?step=project')
      setup(INTAKE_READY)
      for (const step of ['filing', 'reading', 'questions', 'profile']) {
        await userEvent.click(screen.getByRole('button', { name: 'stub next' }))
        expect(shown()).toBe(step)
      }
      expect(screen.queryByRole('button', { name: 'stub next' })).toBeNull()
    })

    it('lets a step send the person to another', async () => {
      at('?step=profile')
      setup(INTAKE_READY)
      await userEvent.click(screen.getByRole('button', { name: 'stub to questions' }))
      expect(shown()).toBe('questions')
      expect(new URLSearchParams(window.location.search).get('step')).toBe('questions')
    })
  })

  describe('what the frame hands a step', () => {
    it('lets a person who may decide decide, and takes uploads', () => {
      setup(INTAKE_READY, { busy: true })
      const step = screen.getByTestId('setup-step-questions')
      expect(step).toHaveAttribute('data-can-decide', 'true')
      expect(step).toHaveAttribute('data-can-upload', 'true')
      expect(step).toHaveAttribute('data-busy', 'true')
    })

    it('decides nothing and takes nothing on a finished setup', () => {
      setup(INTAKE_COMPLETED)
      const step = screen.getByTestId('setup-step-profile')
      expect(step).toHaveAttribute('data-can-decide', 'false')
      expect(step).toHaveAttribute('data-can-upload', 'false')
    })

    it('takes no documents on a closed project', () => {
      at('?step=filing')
      setup(INTAKE_READY, { canUpload: false })
      expect(screen.getByTestId('setup-step-filing')).toHaveAttribute('data-can-upload', 'false')
    })

    it('hands the Ablage the filing suggestions and the upload tray', () => {
      at('?step=filing')
      setup(INTAKE_READY, { filing: { entries: [], onSettled: vi.fn() }, children: <p>upload tray</p> })
      const step = screen.getByTestId('setup-step-filing')
      expect(step).toHaveTextContent('filing given')
      expect(step).toHaveTextContent('upload tray')
    })

  })

  describe('the bar and the footer', () => {
    it('names the setup and the project, and offers to continue later from the overview', () => {
      setup(INTAKE_READY)
      const head = screen.getByTestId('intake-setup-head')
      expect(head).toHaveTextContent('Setup')
      expect(head).toHaveTextContent('Wohnanlage Gartenstraße 12')
      // One link on a desk, one (the back arrow) on a phone; both go to the overview.
      const later = within(head).getAllByRole('link', { name: /Leave the setup for the project overview/ })
      expect(later).toHaveLength(2)
      for (const link of later) expect(link).toHaveAttribute('href', `/app/projects/${INTAKE_READY.projectId}/settings`)
      expect(later[0]).toHaveTextContent('Continue later')
    })

    it('marks a step before the shown one done only when it asks nothing more', () => {
      at('?step=profile')
      setup(INTAKE_READY)
      // Filing asks nothing (documents are in); the Rückfragen still have three open.
      expect(stepButton(/^2\. Filing/).querySelector('svg')).not.toBeNull()
      expect(stepButton(/^4\. Questions/)).toHaveTextContent('4')
      expect(stepButton(/^4\. Questions/).querySelector('svg')).toBeNull()
      expect(stepButton(/^5\. Profile/)).toHaveAttribute('aria-current', 'step')
    })

    it('names the step and its count on a phone, with a menu of all five', async () => {
      setup(INTAKE_READY)
      await userEvent.click(screen.getByRole('button', { name: 'Step 4 of 5: Questions. Choose another step' }))
      await userEvent.click(await screen.findByRole('menuitem', { name: /Profile/ }))
      expect(shown()).toBe('profile')
    })

    it('offers the next step in the footer when a step names no action of its own', async () => {
      setup(INTAKE_READY)
      const footer = screen.getByTestId('intake-setup-footer')
      await userEvent.click(within(footer).getByRole('button', { name: 'On to Profile' }))
      expect(shown()).toBe('profile')
    })

    it('draws the action, the second way on and the progress a step hands it', async () => {
      at('?step=profile')
      setup(INTAKE_CLOSING)
      const footer = screen.getByTestId('intake-setup-footer')
      expect(within(footer).queryByRole('button', { name: /^On to/ })).toBeNull()
      // The aside twice: beside the count on a desk, under the action on a phone.
      expect(within(footer).getAllByRole('button', { name: 'stub aside' })).toHaveLength(2)
      expect(screen.getAllByRole('progressbar', { name: '1 of 6 done' })).toHaveLength(2)
      await userEvent.click(within(footer).getByRole('button', { name: 'stub complete' }))
      expect(onComplete).toHaveBeenCalledTimes(1)
    })
  })

  describe('notices above the step', () => {
    it('says the reading failed, on every step, and offers another', async () => {
      for (const step of ['project', 'profile']) {
        at(`?step=${step}`)
        const { unmount } = setup(INTAKE_FAILED)
        const alert = screen.getByTestId('intake-failed')
        expect(alert).toHaveTextContent('Piloti could not finish reading')
        await userEvent.click(within(alert).getByRole('button', { name: 'Start reading again' }))
        unmount()
      }
      expect(onReread).toHaveBeenCalledTimes(2)
    })

    it('offers no retry in the failed alert to a reader who may not decide', () => {
      setup({ ...INTAKE_FAILED, canDecide: false })
      expect(within(screen.getByTestId('intake-failed')).queryByRole('button')).toBeNull()
    })

    it('offers to retry when the last refresh failed', async () => {
      setup(INTAKE_READY, { stale: true })
      expect(screen.getByText('We could not load the setup.')).toBeInTheDocument()
      await userEvent.click(screen.getByRole('button', { name: 'Try again' }))
      expect(onRetry).toHaveBeenCalledTimes(1)
    })

    it('says why a reader who may not decide cannot', () => {
      setup({ ...INTAKE_READY, canDecide: false })
      expect(screen.getByText('You can look at the setup, not change it.')).toBeInTheDocument()
      expect(screen.getByTestId('setup-step-questions')).toHaveAttribute('data-can-decide', 'false')
    })

    it('says a finished setup is finished, with the way to the project', () => {
      setup(INTAKE_COMPLETED)
      const note = screen.getByTestId('intake-completed')
      expect(note).toHaveTextContent('The setup is finished.')
      expect(within(note).getByRole('link', { name: 'To the overview' })).toHaveAttribute(
        'href',
        `/app/projects/${INTAKE_COMPLETED.projectId}/settings`
      )
    })
  })

  describe('drops', () => {
    const dataTransfer = (file: File) => ({ dataTransfer: { types: ['Files'], files: [file], items: [] } })

    it.each(['project', 'filing', 'reading', 'questions', 'profile'])('files a document dropped anywhere on the %s step', async (step) => {
      at(`?step=${step}`)
      setup(INTAKE_READY)
      const file = new File(['%PDF'], 'EG.pdf', { type: 'application/pdf' })

      fireEvent.drop(screen.getByTestId('intake-setup'), dataTransfer(file))

      await vi.waitFor(() => expect(onFiles).toHaveBeenCalledWith([file], { truncated: false, unreadable: 0 }))
    })

    it('takes no drop on a finished setup', () => {
      setup(INTAKE_COMPLETED)
      fireEvent.drop(screen.getByTestId('intake-setup'), dataTransfer(new File(['%PDF'], 'EG.pdf', { type: 'application/pdf' })))
      expect(onFiles).not.toHaveBeenCalled()
    })
  })

  it('has a fixture for every state', () => {
    expect(Object.keys(INTAKE_FIXTURES).sort()).toEqual(['closing', 'completed', 'failed', 'reading', 'ready', 'waiting'])
  })
})
