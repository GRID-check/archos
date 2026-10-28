/**
 * Step 2, Ablage, inside the setup's footer: the drop area and the folder
 * picker as the one primary action; the project folder as a tree before the
 * upload, switched per folder; what the sensitive-data list keeps on the
 * server and the project's changes to it (in a sheet); who opens which folder
 * (in a sheet); only the chosen files reach the upload; the upload on its way;
 * the project's folders once documents are in; and Piloti's open filing
 * suggestions (carried over from the frame's spec).
 */
import type { JSX } from 'react'
import { fireEvent, render, screen, within } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { server } from '@/mocks/server'
import { resetKit, useFakeStream } from '@/features/cards/components/proposal-test-kit'
import { suggestionsByFolder } from '@/features/documents/lib/filing-suggestions'
import {
  INTAKE_COMPLETED,
  INTAKE_FILING,
  INTAKE_READY,
  INTAKE_WAITING,
} from '@/app/dev/_fixtures/project-intake'
import {
  FILING_FOLDERS_UPLOADED,
  FILING_PROJECT_FOLDER,
  FILING_SCREENING,
  FILING_SCREENING_READONLY,
  fakeFilingClient,
} from '@/app/dev/_fixtures/project-setup-filing'
import type { IntakeView } from '@/lib/project-intake/types'
import type { FilingSetupClient } from '../filing/filing-client'
import { SetupFooter, StepFooterProvider, useStepFooterChannel } from '../setup-frame'
import { FilingStep, type FilingStepProps } from './filing-step'

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

const onFiles = vi.fn()
const onNext = vi.fn()

/** The step inside the setup's footer, as the page draws it: the step names its actions there. */
function Framed(props: FilingStepProps): JSX.Element {
  const footer = useStepFooterChannel()
  return (
    <StepFooterProvider value={footer.channel}>
      <FilingStep {...props} />
      <SetupFooter
        step="filing"
        progress={footer.progress}
        ownsPrimary={footer.ownsPrimary}
        slotRef={footer.slotRef}
        onNext={props.onNext}
      />
    </StepFooterProvider>
  )
}

function setup(view: IntakeView, props: Partial<FilingStepProps> = {}, client?: FilingSetupClient) {
  const used = client ?? fakeFilingClient(FILING_SCREENING, [])
  return {
    client: used,
    ...render(
      <Framed
        view={view}
        projectId={view.projectId}
        busy={false}
        canDecide
        canUpload
        uploading={false}
        onDecide={async () => true}
        onFiles={onFiles}
        onReread={() => undefined}
        onNext={onNext}
        onGoTo={() => undefined}
        client={used}
        {...props}
      />
    ),
  }
}

const row = (path: string): HTMLElement => {
  const found = screen.getAllByTestId('filing-tree-row').find((element) => element.dataset.path === path)
  if (!found) throw new Error(`no row ${path}`)
  return found
}

const footer = (): HTMLElement => screen.getByTestId('intake-setup-footer')

describe('FilingStep', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('choosing the project folder', () => {
    it('offers a calm drop area, the folder picker as the one primary action, and a way on without documents', async () => {
      const user = userEvent.setup()
      setup(INTAKE_WAITING)
      const zone = screen.getByTestId('intake-upload-zone')
      expect(within(zone).getByText('Drag the project folder here')).toBeInTheDocument()
      expect(screen.queryByTestId('filing-choice')).toBeNull()
      expect(within(footer()).getByRole('button', { name: 'Choose project folder' })).toBeInTheDocument()
      // On a desk and under the thumb: the aside is drawn in both footer slots.
      await user.click(within(footer()).getAllByRole('button', { name: 'Continue without documents' })[0] as HTMLElement)
      expect(onNext).toHaveBeenCalled()
    })

    it('shows a chosen folder as a tree before anything is sent', async () => {
      setup(INTAKE_WAITING)
      fireEvent.change(screen.getByTestId('project-upload-folder-input'), { target: { files: FILING_PROJECT_FOLDER } })

      expect(await screen.findByTestId('filing-choice')).toBeInTheDocument()
      expect(onFiles).not.toHaveBeenCalled()
      expect(row('Wohnbau Nord/01_Grundlagen')).toHaveTextContent('3 · 4 MB')
    })

    it('sends picked loose files straight to the upload: there is no tree to confirm', async () => {
      setup(INTAKE_WAITING)
      const loose = new File(['x'], 'Lageplan.pdf', { type: 'application/pdf' })
      fireEvent.change(screen.getByTestId('project-upload-input'), { target: { files: [loose] } })
      await vi.waitFor(() => expect(onFiles).toHaveBeenCalledWith([loose]))
      expect(screen.queryByTestId('filing-choice')).toBeNull()
    })
  })

  describe('the tree', () => {
    it('proposes backups, temporary folders and old states out, and says so', async () => {
      setup(INTAKE_WAITING, { initialChoice: FILING_PROJECT_FOLDER })
      expect(row('Wohnbau Nord/Backup')).toHaveAttribute('data-state', 'out')
      expect(row('Wohnbau Nord/Backup')).toHaveTextContent('backup')
      expect(row('Wohnbau Nord/temp')).toHaveAttribute('data-state', 'out')
      expect(row('Wohnbau Nord/03_Einreichung')).toHaveAttribute('data-state', 'partial')
      expect(screen.getByTestId('filing-choice')).toHaveTextContent('15 of 19')
      expect(screen.getByTestId('filing-summary')).toHaveTextContent(/old states, backups,? and working copies left out/)
      expect(await within(footer()).findByRole('button', { name: 'Upload 15 files' })).toBeInTheDocument()
    })

    it('opens a folder with subfolders in place', async () => {
      const user = userEvent.setup()
      setup(INTAKE_WAITING, { initialChoice: FILING_PROJECT_FOLDER })
      expect(screen.queryAllByTestId('filing-tree-row').some((element) => element.dataset.path?.endsWith('/_alt'))).toBe(false)
      await user.click(screen.getByRole('button', { name: 'Expand “03_Einreichung”' }))
      expect(row('Wohnbau Nord/03_Einreichung/_alt')).toHaveAttribute('data-state', 'out')
    })

    it('uploads only the folders switched on, through the project upload', async () => {
      const user = userEvent.setup()
      setup(INTAKE_WAITING, { initialChoice: FILING_PROJECT_FOLDER })
      await user.click(within(row('Wohnbau Nord/02_Bestand')).getByRole('checkbox', { name: 'Upload “02_Bestand”' }))
      expect(row('Wohnbau Nord/02_Bestand')).toHaveAttribute('data-state', 'out')

      await user.click(await within(footer()).findByRole('button', { name: 'Upload 13 files' }))

      expect(onFiles).toHaveBeenCalledTimes(1)
      const sent = (onFiles.mock.calls[0]?.[0] as File[]).map((file) => file.webkitRelativePath)
      expect(sent).toHaveLength(13)
      expect(sent.some((path) => path.includes('/02_Bestand/') || path.includes('/Backup/') || path.includes('/_alt/'))).toBe(false)
      expect(screen.queryByTestId('filing-choice')).toBeNull()
      expect(screen.getByTestId('filing-sent')).toBeInTheDocument()
    })

    it('discards a choice without sending anything', async () => {
      const user = userEvent.setup()
      setup(INTAKE_WAITING, { initialChoice: FILING_PROJECT_FOLDER })
      await user.click(screen.getByRole('button', { name: 'Choose another folder' }))
      expect(screen.queryByTestId('filing-choice')).toBeNull()
      expect(screen.getByTestId('intake-upload-zone')).toBeInTheDocument()
      expect(onFiles).not.toHaveBeenCalled()
    })
  })

  describe('sensitive data', () => {
    it("names what the office's list keeps on the server of the choice, and where", async () => {
      setup(INTAKE_WAITING, { initialChoice: FILING_PROJECT_FOLDER })
      expect(await screen.findByTestId('filing-held')).toHaveTextContent('3 files stay on the server')
      // „Bauvertrag" is one of the office's exceptions, so only the Werkvertrag is held.
      expect(screen.getByTestId('filing-screening')).toHaveTextContent('Matches for “Honorar” and “Vertrag”')
      expect(row('Wohnbau Nord/07_Honorare')).toHaveTextContent('2 stay here')
      expect(row('Wohnbau Nord/06_Verträge')).toHaveTextContent('1 stays here')
    })

    it('lets a project manager set an office term aside for this project, previewed before it is saved', async () => {
      const user = userEvent.setup()
      const client = fakeFilingClient(FILING_SCREENING, [])
      const save = vi.spyOn(client, 'saveScreening')
      setup(INTAKE_WAITING, { initialChoice: FILING_PROJECT_FOLDER }, client)

      await user.click(await screen.findByRole('button', { name: 'Adjust for this project' }))
      const editor = await screen.findByTestId('filing-screening-editor')
      await user.click(within(editor).getByRole('button', { name: '“Vertrag” applies in this project' }))
      // The contracts are no longer held back in the preview, before any save.
      expect(within(editor).getByTestId('filing-screening-preview')).toHaveTextContent('With this list, 2 files stay on the server.')
      expect(screen.getByTestId('filing-held')).toHaveTextContent('2 files stay on the server')
      await user.click(within(editor).getByRole('button', { name: 'Save for the project' }))

      expect(save).toHaveBeenCalledWith(INTAKE_WAITING.projectId, { addedNameTerms: [], removedNameTerms: ['Vertrag'] })
      await vi.waitFor(() => expect(screen.queryByTestId('filing-screening-editor')).toBeNull())
      expect(screen.getByTestId('filing-screening')).toHaveTextContent("this project's list")
    })

    it('shows the list without a way to change it to a member who does not manage the project', async () => {
      const user = userEvent.setup()
      setup(INTAKE_WAITING, { initialChoice: FILING_PROJECT_FOLDER }, fakeFilingClient(FILING_SCREENING_READONLY, []))
      expect(await screen.findByText('Only someone who manages the project can change its list.')).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Adjust for this project' })).toBeNull()
      await user.click(screen.getByRole('button', { name: 'See who opens what' }))
      expect(within(await screen.findByTestId('filing-access')).queryByRole('button', { name: /Restrict/ })).toBeNull()
    })

    it('waits with the upload while the list cannot be read, and offers to load it again', async () => {
      const client = fakeFilingClient(FILING_SCREENING, [])
      client.loadScreening = vi.fn().mockRejectedValue(new Error('down'))
      setup(INTAKE_WAITING, { initialChoice: FILING_PROJECT_FOLDER }, client)
      expect(await screen.findByRole('button', { name: 'Load again' })).toBeInTheDocument()
      fireEvent.click(within(footer()).getByRole('button', { name: /Upload 15 files/ }))
      expect(onFiles).not.toHaveBeenCalled()
    })
  })

  describe('folder access', () => {
    it("lists the choice's top folders as new, with the way to restrict one before its files arrive", async () => {
      const user = userEvent.setup()
      const client = fakeFilingClient(FILING_SCREENING, [])
      const ensure = vi.spyOn(client, 'ensureFolder')
      setup(INTAKE_WAITING, { initialChoice: FILING_PROJECT_FOLDER }, client)

      expect(screen.getByTestId('filing-access-summary')).toHaveTextContent('Everyone in the project sees every folder')
      await user.click(await screen.findByRole('button', { name: 'Restrict a folder' }))
      const access = await screen.findByTestId('filing-access')
      const paths = within(access)
        .getAllByTestId('filing-access-row')
        .map((element) => element.dataset.path)
      expect(paths).toContain('Wohnbau Nord/07_Honorare')
      // A folder switched out is not uploaded, so there is nothing to restrict.
      expect(paths).not.toContain('Wohnbau Nord/Backup')
      await user.click(within(access).getByRole('button', { name: 'Restrict “07_Honorare” before uploading' }))
      expect(ensure).toHaveBeenCalledWith(INTAKE_WAITING.projectId, 'Wohnbau Nord/07_Honorare')
    })

    it("shows who opens each of the project's folders", async () => {
      const user = userEvent.setup()
      setup(INTAKE_READY, {}, fakeFilingClient(FILING_SCREENING, FILING_FOLDERS_UPLOADED))
      const summary = screen.getByTestId('filing-access-summary')
      await vi.waitFor(() => expect(summary).toHaveTextContent('2 folders are restricted'))
      await user.click(within(summary).getByRole('button', { name: 'Manage access' }))
      const access = await screen.findByTestId('filing-access')
      const fees = within(access)
        .getAllByTestId('filing-access-row')
        .find((element) => element.dataset.path === 'Wohnbau Nord/07_Honorare')
      expect(fees).toHaveTextContent('Only the people on its own list')
      expect(within(access).getAllByTestId('filing-access-row')[0]).toHaveTextContent('Everyone in the project, by project role')
      expect(within(access).getByRole('button', { name: 'Change access to “07_Honorare”' })).toBeInTheDocument()
    })
  })

  describe('with documents in the project', () => {
    it("lists the project's folders, offers more, and leaves the way on to the frame", async () => {
      const user = userEvent.setup()
      setup(INTAKE_READY, {}, fakeFilingClient(FILING_SCREENING, FILING_FOLDERS_UPLOADED))
      const card = screen.getByTestId('filing-project-folders')
      await vi.waitFor(() => expect(within(card).getAllByTestId('filing-project-folder')).toHaveLength(7))
      expect(within(card).getByRole('button', { name: 'Add more folders' })).toBeInTheDocument()
      await user.click(within(footer()).getByRole('button', { name: /On to/ }))
      expect(onNext).toHaveBeenCalled()
    })

    it('says the documents are on their way while they upload', () => {
      setup(INTAKE_WAITING, { uploading: true })
      expect(screen.getByTestId('filing-uploading')).toBeInTheDocument()
      expect(within(footer()).getByRole('button', { name: 'Uploading …' })).toHaveAttribute('aria-busy', 'true')
    })
  })

  describe("Piloti's open filing suggestions", () => {
    const [permits] = INTAKE_FILING
    const onSettled = vi.fn()
    const filing = (entries = suggestionsByFolder(INTAKE_FILING)) => ({ filing: { entries, onSettled } })
    let current = permits.proposal

    beforeEach(() => {
      useFakeStream()
      current = permits.proposal
      server.use(
        http.get('/api/proposals/:id', ({ params }) =>
          HttpResponse.json({ proposal: INTAKE_FILING.find((entry) => entry.proposal.id === params.id)?.proposal ?? current })
        ),
        http.post(`/api/proposals/${permits.proposal.id}/apply`, () => {
          current = { ...permits.proposal, status: 'applied', canDecide: false, results: [] }
          return HttpResponse.json({ proposal: current })
        })
      )
    })
    afterEach(resetKit)

    it('renders the filing bar, one line per target folder with the files that go there', async () => {
      setup(INTAKE_READY, filing())

      const section = screen.getByTestId('intake-filing')
      expect(within(section).getByRole('heading', { name: 'Filing' })).toBeInTheDocument()
      // The same FilingBar as above a folder in Files, not a lookalike.
      const bar = within(section).getByTestId('filing-bar')
      expect(bar).toHaveAttribute('role', 'group')
      const lines = within(bar).getAllByTestId('filing-bar-line')
      expect(lines).toHaveLength(2)
      expect(lines[0]).toHaveTextContent('Behörde/Bescheide')
      expect(lines[0]).toHaveTextContent('2 files')
      expect(lines[0]).toHaveTextContent('Bescheid_MA37_Aufstockung.pdf, Stellungnahme_MA19_Ortsbild.pdf')
      expect(lines[1]).toHaveTextContent('Gutachten')
      expect(within(lines[1]).getByText('new')).toBeInTheDocument()
      expect(await within(lines[1]).findByRole('button', { name: 'Create and move' })).toBeInTheDocument()
    })

    it('applies through the proposals service and tells the page to re-read', async () => {
      const user = userEvent.setup()
      setup(INTAKE_READY, filing())

      const [permitsLine] = screen.getAllByTestId('filing-bar-line')
      await user.click(await within(permitsLine).findByRole('button', { name: 'Move' }))

      expect(await screen.findByText('Moved to “Behörde/Bescheide”.')).toBeInTheDocument()
      await vi.waitFor(() => expect(onSettled).toHaveBeenCalled())
    })

    it('draws nothing when there is no open suggestion', () => {
      setup(INTAKE_READY, filing([]))
      expect(screen.queryByTestId('intake-filing')).toBeNull()
    })

    it('draws nothing when the step is given no suggestions', () => {
      setup(INTAKE_READY)
      expect(screen.queryByTestId('intake-filing')).toBeNull()
    })

    it('draws nothing once the setup is finished', () => {
      setup(INTAKE_COMPLETED, filing())
      expect(screen.queryByTestId('intake-filing')).toBeNull()
    })
  })
})
