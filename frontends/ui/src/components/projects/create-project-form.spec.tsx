/**
 * Creating a project, running or already closed: what reaches the server
 * action, and what keeps the submit shut. And the setup: the address (a text
 * field that keeps what is typed, with the address search's hits where one is
 * configured),
 * „Worum geht es?" folded behind a line, and a project folder dropped on the
 * dialog or chosen in its zone.
 */
import { fireEvent, render, screen, waitFor } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { redirect } from 'next/navigation'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { createProject } from '@/app/app/(shell)/projects/actions'
import { takeDroppedFiles } from '@/features/documents/lib/dropped-file-handover'
import { capturePosthog } from '@/lib/analytics/posthog'
import type { GeocodeResponse, GeocodeResult } from '@/lib/geocoding/types'
import { forgetGeocoderAnswer } from './address-field'
import { CreateProjectForm, folderNameOf } from './create-project-form'

/** The key this dialog holds a drop under: one per dialog, fixed here so a spec can look. */
const DROP_KEY = 'new-project:00000000-0000-4000-8000-000000000000'
vi.mock('@/features/documents/lib/dropped-file-handover', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/features/documents/lib/dropped-file-handover')>()),
  newProjectDropKey: () => DROP_KEY,
}))
vi.mock('@/app/app/(shell)/projects/actions', () => ({ createProject: vi.fn() }))
vi.mock('@/lib/analytics/posthog', () => ({ capturePosthog: vi.fn() }))
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

const search = vi.hoisted(() => vi.fn())
vi.mock('@/lib/geocoding/client', () => ({ createGeocodingClient: () => ({ search }) }))
const findSameAddress = vi.hoisted(() => vi.fn())
vi.mock('@/lib/projects/same-address-client', () => ({ createSameAddressClient: () => ({ find: findSameAddress }) }))

const hauptstrasse: GeocodeResult = {
  label: 'Hauptstraße 12, 1010 Wien',
  lat: 48.2,
  lon: 16.37,
  country: 'at',
  bundesland: 'wien',
  state: 'Wien',
  gemeinde: 'Wien',
  postcode: '1010',
  kind: 'address',
}
const moedling: GeocodeResult = {
  label: 'Hauptstraße 3, 2340 Mödling',
  lat: 48.08,
  lon: 16.28,
  country: 'at',
  bundesland: 'niederoesterreich',
  state: 'Niederösterreich',
  gemeinde: 'Mödling',
  postcode: '2340',
  kind: 'address',
}

const action = vi.mocked(createProject)

/** The fields of the FormData the action was last called with. */
function sent(): Record<string, string> {
  const formData = action.mock.calls.at(-1)?.[1]
  return Object.fromEntries([...(formData?.entries() ?? [])].map(([key, value]) => [key, String(value)]))
}

async function pick(user: ReturnType<typeof userEvent.setup>, combobox: string, option: string): Promise<void> {
  await user.click(screen.getByRole('combobox', { name: combobox }))
  await user.click(await screen.findByRole('option', { name: option }))
}

const submit = (name: RegExp = /^Create project$/) => screen.getByRole('button', { name })

describe('CreateProjectForm', () => {
  beforeEach(() => {
    // Only the clock: the Abschluss bounds read this month, and userEvent needs real timers.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-03-15T12:00:00Z'))
    action.mockReset()
    // What the real action does on success: it never returns, it redirects.
    action.mockImplementation(async () => redirect('/app/projects/p1/setup'))
    vi.mocked(capturePosthog).mockClear()
    search.mockReset()
    findSameAddress.mockReset()
    findSameAddress.mockResolvedValue({ projects: [] })
    forgetGeocoderAnswer()
    takeDroppedFiles(DROP_KEY)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  test('a running project sends its name and state=active, and nothing of a close', async () => {
    const user = userEvent.setup()
    render(<CreateProjectForm />)

    expect(submit()).toBeDisabled()
    expect(screen.getByRole('radio', { name: /Ongoing/ })).toBeChecked()
    expect(screen.queryByTestId('create-project-closed')).toBeNull()

    await user.type(screen.getByLabelText('Project name'), '  Wohnhaus Hauptstraße 12 ')
    await user.click(submit())

    await waitFor(() => expect(action).toHaveBeenCalledTimes(1))
    expect(sent()).toEqual({ name: 'Wohnhaus Hauptstraße 12', state: 'active', setup: 'piloti' })
    expect(capturePosthog).toHaveBeenCalledWith('project_created', { state: 'active', setup: 'piloti' })
  })

  test('a closed project needs its outcome, then sends outcome, Beginn and Abschluss', async () => {
    const user = userEvent.setup()
    render(<CreateProjectForm />)

    await user.type(screen.getByLabelText('Project name'), 'Schule Nord')
    await user.click(screen.getByRole('radio', { name: /Closed/ }))

    expect(await screen.findByTestId('create-project-closed')).toBeInTheDocument()
    const closedSubmit = submit()
    // Not preselected: a default would nudge the record towards the wrong outcome.
    expect(screen.getByRole('radio', { name: /Completed/ })).not.toBeChecked()
    expect(screen.getByRole('radio', { name: /Not realized/ })).not.toBeChecked()
    expect(closedSubmit).toBeDisabled()

    await user.click(screen.getByRole('radio', { name: /Not realized/ }))
    expect(closedSubmit).toBeEnabled()
    await user.click(closedSubmit)

    await waitFor(() => expect(action).toHaveBeenCalledTimes(1))
    expect(sent()).toEqual({
      name: 'Schule Nord',
      state: 'closed',
      setup: 'piloti',
      outcome: 'cancelled',
      startedOn: '',
      endedOn: '2026-03',
    })
    expect(capturePosthog).toHaveBeenCalledWith('project_created', { state: 'closed', setup: 'piloti' })
  })

  test('sends a chosen Beginn', async () => {
    const user = userEvent.setup()
    render(<CreateProjectForm />)

    await user.type(screen.getByLabelText('Project name'), 'Halle Süd')
    await user.click(screen.getByRole('radio', { name: /Closed/ }))
    await user.click(await screen.findByRole('radio', { name: /Completed/ }))
    await pick(user, 'Start, Month', 'June')
    await pick(user, 'Start, Year', '2019')
    await user.click(submit())

    await waitFor(() => expect(action).toHaveBeenCalledTimes(1))
    expect(sent()).toMatchObject({ outcome: 'completed', startedOn: '2019-06', endedOn: '2026-03' })
  })

  test('an Abschluss in the future shows the error and keeps the submit shut', async () => {
    const user = userEvent.setup()
    render(<CreateProjectForm />)

    await user.type(screen.getByLabelText('Project name'), 'Villa K')
    await user.click(screen.getByRole('radio', { name: /Closed/ }))
    await user.click(await screen.findByRole('radio', { name: /Completed/ }))
    await pick(user, 'Completion, Month', 'December')

    expect(screen.getByRole('alert')).toHaveTextContent('The completion cannot lie in the future.')
    expect(submit()).toBeDisabled()
    expect(action).not.toHaveBeenCalled()
  })

  test("the server's Abschluss reason lands on the Abschluss field, not in a general alert", async () => {
    action.mockResolvedValue({ error: 'refused', reason: 'abschluss-before-beginn' })
    const user = userEvent.setup()
    render(<CreateProjectForm />)

    await user.type(screen.getByLabelText('Project name'), 'Villa K')
    await user.click(screen.getByRole('radio', { name: /Closed/ }))
    await user.click(await screen.findByRole('radio', { name: /Completed/ }))
    await user.click(submit())

    expect(await screen.findByText('The completion lies before the start.')).toBeInTheDocument()
    expect(screen.queryByText(/couldn't create this project/)).toBeNull()
    expect(capturePosthog).not.toHaveBeenCalled()
  })

  test('any other failure shows the calm message, never the raw error', async () => {
    action.mockResolvedValue({ error: 'duplicate key value violates unique constraint' })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const user = userEvent.setup()
    render(<CreateProjectForm />)

    await user.type(screen.getByLabelText('Project name'), 'Villa K')
    await user.click(submit())

    expect(await screen.findByText(/couldn't create this project/)).toBeInTheDocument()
    expect(screen.queryByText(/duplicate key/)).toBeNull()
  })

  test('Cancel calls onCancel without submitting', async () => {
    const onCancel = vi.fn()
    render(<CreateProjectForm onCancel={onCancel} />)
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(action).not.toHaveBeenCalled()
  })

  describe('on a phone', () => {
    const pointer = (kind: 'coarse' | 'fine'): void => {
      vi.stubGlobal('matchMedia', (query: string) => ({
        matches: query === `(pointer: ${kind})`,
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }))
    }
    afterEach(() => vi.unstubAllGlobals())

    test('the name field is not focused on open: that would put the keyboard over the form', () => {
      pointer('coarse')
      render(<CreateProjectForm />)
      expect(screen.getByLabelText('Project name')).not.toHaveFocus()
    })

    test('a mouse still starts in the name field', () => {
      pointer('fine')
      render(<CreateProjectForm />)
      expect(screen.getByLabelText('Project name')).toHaveFocus()
    })

    test('the folder zone offers documents, not a drag or a folder picker a touch screen does not have', () => {
      pointer('coarse')
      render(<CreateProjectForm />)
      expect(screen.getByTestId('create-project-folder-zone')).toHaveTextContent('Add the project documents')
      expect(screen.getByTestId('create-project-folder-input')).not.toHaveAttribute('webkitdirectory')
    })

    test('a mouse is offered the drag and the folder picker', () => {
      pointer('fine')
      render(<CreateProjectForm />)
      expect(screen.getByTestId('create-project-folder-zone')).toHaveTextContent('Drag the project folder here')
      expect(screen.getByTestId('create-project-folder-input')).toHaveAttribute('webkitdirectory')
    })
  })

  describe('Piloti sets it up', () => {
    test('a chosen address is sent as the location, with „Worum geht es?"', async () => {
      search.mockResolvedValue({ enabled: true, results: [hauptstrasse, moedling] } satisfies GeocodeResponse)
      const user = userEvent.setup()
      render(<CreateProjectForm />)

      await user.type(screen.getByLabelText('Project name'), 'Aufstockung')
      // Folded until asked for.
      expect(screen.queryByRole('textbox', { name: 'What is it about?' })).toBeNull()
      await user.click(screen.getByRole('button', { name: 'Briefly describe what it is about' }))
      await user.type(screen.getByRole('textbox', { name: 'What is it about?' }), 'Zwei Geschoße mehr')
      await user.type(screen.getByRole('combobox', { name: 'Address' }), 'Hauptstraße')
      await user.click(await screen.findByRole('option', { name: /Hauptstraße 12, 1010 Wien/ }))

      // The chosen hit names its Gemeinde and Bundesland.
      expect(screen.getByTestId('create-project-address-place')).toHaveTextContent('Wien · Wien')
      await user.click(submit())

      await waitFor(() => expect(action).toHaveBeenCalledTimes(1))
      expect(sent()).toEqual({
        name: 'Aufstockung',
        state: 'active',
        setup: 'piloti',
        description: 'Zwei Geschoße mehr',
        location: JSON.stringify(hauptstrasse),
      })
    })

    test('asks the address search after 250 ms of quiet, and aborts the request a keystroke outdates', async () => {
      const signals: AbortSignal[] = []
      search.mockImplementation((_q: string, _limit: number, init?: { signal?: AbortSignal }) => {
        if (init?.signal) signals.push(init.signal)
        return new Promise(() => {})
      })
      render(<CreateProjectForm />)
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
      const input = screen.getByRole('combobox', { name: 'Address' })

      fireEvent.change(input, { target: { value: 'Haupt' } })
      vi.advanceTimersByTime(249)
      expect(search).not.toHaveBeenCalled()
      vi.advanceTimersByTime(1)
      expect(search).toHaveBeenCalledWith('Haupt', 5, { signal: expect.any(AbortSignal) })

      // The next keystroke outdates the request still in flight.
      fireEvent.change(input, { target: { value: 'Hauptstr' } })
      expect(signals[0]?.aborted).toBe(true)
      vi.advanceTimersByTime(250)
      expect(search).toHaveBeenCalledTimes(2)
      expect(signals[1]?.aborted).toBe(false)

      // Under three characters nothing is asked.
      fireEvent.change(input, { target: { value: 'Ha' } })
      expect(signals[1]?.aborted).toBe(true)
      vi.advanceTimersByTime(1000)
      expect(search).toHaveBeenCalledTimes(2)
      vi.useRealTimers()
    })

    test('the list is keyboard navigable: arrows move, Enter chooses, Escape closes only the list', async () => {
      search.mockResolvedValue({ enabled: true, results: [hauptstrasse, moedling] } satisfies GeocodeResponse)
      const user = userEvent.setup()
      const onCancel = vi.fn()
      render(<CreateProjectForm onCancel={onCancel} />)

      const combobox = screen.getByRole('combobox', { name: 'Address' })
      await user.type(combobox, 'Hauptstraße')
      const options = await screen.findAllByRole('option')
      expect(options).toHaveLength(2)
      expect(combobox).toHaveAttribute('aria-expanded', 'true')
      expect(combobox).toHaveAttribute('aria-activedescendant', options[0].id)

      await user.keyboard('{ArrowDown}')
      expect(combobox).toHaveAttribute('aria-activedescendant', options[1].id)
      await user.keyboard('{ArrowDown}')
      expect(combobox).toHaveAttribute('aria-activedescendant', options[0].id)
      await user.keyboard('{ArrowUp}')
      expect(combobox).toHaveAttribute('aria-activedescendant', options[1].id)

      await user.keyboard('{Escape}')
      expect(screen.queryByRole('option')).toBeNull()
      expect(combobox).toHaveAttribute('aria-expanded', 'false')

      await user.keyboard('{ArrowDown}')
      expect(screen.getAllByRole('option')).toHaveLength(2)
      await user.keyboard('{ArrowDown}')
      await user.keyboard('{Enter}')
      // Enter chose; it did not submit the form.
      expect(combobox).toHaveValue('Hauptstraße 3, 2340 Mödling')
      expect(screen.getByTestId('create-project-address-place')).toHaveTextContent('Mödling · Niederösterreich')
      expect(action).not.toHaveBeenCalled()
    })

    test('an address with no match is kept as typed and sent', async () => {
      search.mockResolvedValue({ enabled: true, results: [] } satisfies GeocodeResponse)
      const user = userEvent.setup()
      render(<CreateProjectForm />)

      await user.type(screen.getByLabelText('Project name'), 'Wettbewerb')
      await user.type(screen.getByRole('combobox', { name: 'Address' }), 'Am Bahnhof 4, Gänserndorf')
      await waitFor(() => expect(search).toHaveBeenCalled())
      await user.click(submit())

      await waitFor(() => expect(action).toHaveBeenCalledTimes(1))
      expect(sent()).toEqual({ name: 'Wettbewerb', state: 'active', setup: 'piloti', address: 'Am Bahnhof 4, Gänserndorf' })
    })

    test('editing a chosen address lets go of the hit: the line is sent as typed', async () => {
      search.mockResolvedValue({ enabled: true, results: [hauptstrasse] } satisfies GeocodeResponse)
      const user = userEvent.setup()
      render(<CreateProjectForm />)

      await user.type(screen.getByLabelText('Project name'), 'Aufstockung')
      const field = screen.getByRole('combobox', { name: 'Address' })
      await user.type(field, 'Hauptstraße')
      await user.click(await screen.findByRole('option', { name: /Hauptstraße 12/ }))
      search.mockResolvedValue({ enabled: true, results: [] } satisfies GeocodeResponse)
      await user.type(field, '/3')
      expect(screen.queryByTestId('create-project-address-place')).toBeNull()
      await user.click(submit())

      await waitFor(() => expect(action).toHaveBeenCalledTimes(1))
      expect(sent()).toMatchObject({ address: 'Hauptstraße 12, 1010 Wien/3' })
      expect(sent()).not.toHaveProperty('location')
    })

    test('with no address search configured, the field stays a text field and keeps what was typed', async () => {
      search.mockResolvedValue({ enabled: false, results: [] } satisfies GeocodeResponse)
      const user = userEvent.setup()
      render(<CreateProjectForm />)

      await user.type(screen.getByLabelText('Project name'), 'Haus am See')
      await user.type(screen.getByRole('combobox', { name: 'Address' }), 'Seestraße 5, 9220 Velden')

      // The pilot onboarding typed three letters and lost them to a Bundesland select.
      const field = await screen.findByRole('textbox', { name: 'Address' })
      expect(field).toHaveValue('Seestraße 5, 9220 Velden')
      expect(screen.queryByRole('combobox', { name: 'Bundesland' })).toBeNull()
      await user.click(submit())

      await waitFor(() => expect(action).toHaveBeenCalledTimes(1))
      expect(sent()).toEqual({ name: 'Haus am See', state: 'active', setup: 'piloti', address: 'Seestraße 5, 9220 Velden' })
      expect(search).toHaveBeenCalledTimes(1)
    })

    test('remembers that there is no address search, so the next dialog asks no more', async () => {
      search.mockResolvedValue({ enabled: false, results: [] } satisfies GeocodeResponse)
      const user = userEvent.setup()
      const first = render(<CreateProjectForm />)
      await user.type(screen.getByRole('combobox', { name: 'Address' }), 'Seestraße')
      await screen.findByRole('textbox', { name: 'Address' })
      first.unmount()

      render(<CreateProjectForm />)
      await user.type(screen.getByRole('textbox', { name: 'Address' }), 'Hauptplatz 1')
      expect(search).toHaveBeenCalledTimes(1)
    })

    test('links the earlier projects at the chosen address', async () => {
      search.mockResolvedValue({ enabled: true, results: [hauptstrasse] } satisfies GeocodeResponse)
      findSameAddress.mockResolvedValue({
        projects: [
          { id: 'p-old', name: 'Wohnhaus Hauptstraße 12', status: 'closed' },
          { id: 'p-2', name: 'Dachausbau', status: 'active' },
        ],
      })
      const user = userEvent.setup()
      render(<CreateProjectForm />)

      await user.type(screen.getByRole('combobox', { name: 'Address' }), 'Hauptstraße')
      await user.click(await screen.findByRole('option', { name: /Hauptstraße 12/ }))

      expect(await screen.findByText('There is already a project at this address')).toBeInTheDocument()
      expect(findSameAddress).toHaveBeenCalledWith(
        { label: 'Hauptstraße 12, 1010 Wien', lat: 48.2, lon: 16.37 },
        { signal: expect.any(AbortSignal) }
      )
      const link = screen.getByRole('link', { name: /Wohnhaus Hauptstraße 12/ })
      expect(link).toHaveAttribute('href', '/app/projects/p-old')
      expect(link).toHaveAttribute('target', '_blank')
      expect(link).toHaveTextContent('(closed)')
    })

    test('says nothing about earlier projects when there are none', async () => {
      search.mockResolvedValue({ enabled: true, results: [hauptstrasse] } satisfies GeocodeResponse)
      const user = userEvent.setup()
      render(<CreateProjectForm />)

      await user.type(screen.getByRole('combobox', { name: 'Address' }), 'Hauptstraße')
      await user.click(await screen.findByRole('option', { name: /Hauptstraße 12/ }))
      await waitFor(() => expect(findSameAddress).toHaveBeenCalled())
      expect(screen.queryByTestId('create-project-same-address')).toBeNull()
    })

    test('a closed project Piloti sets up says it closes when the review is finished', async () => {
      const user = userEvent.setup()
      render(<CreateProjectForm />)

      await user.click(screen.getByRole('radio', { name: /Closed/ }))
      expect(await screen.findByTestId('create-project-closed-note')).toHaveTextContent(
        'The project stays open while Piloti reads its documents. It closes when you finish the review.'
      )
    })

    test('a dropped project folder names an empty project and waits for the setup page', async () => {
      const user = userEvent.setup()
      render(<CreateProjectForm />)
      const files = [
        withPath(new File(['a'], 'Baubeschreibung.pdf'), 'Wohnbau Nord/Baubeschreibung.pdf'),
        withPath(new File(['b'], 'EG.pdf'), 'Wohnbau Nord/Einreichung/EG.pdf'),
      ]

      dropFiles(screen.getByTestId('create-project-drop'), files)

      expect(await screen.findByTestId('create-project-dropped')).toHaveTextContent('Folder “Wohnbau Nord”: 2 files')
      expect(screen.getByLabelText('Project name')).toHaveValue('Wohnbau Nord')
      expect(takeDroppedFiles(DROP_KEY)).toEqual(files)
      // Taken once: put it back for the rest of the test.
      await user.click(screen.getByRole('button', { name: 'Remove the folder' }))
      expect(screen.queryByTestId('create-project-dropped')).toBeNull()
    })

    test('a folder chosen in the picker is held the same way as a dropped one', async () => {
      const user = userEvent.setup()
      render(<CreateProjectForm />)
      const files = [withPath(new File(['a'], 'a.pdf'), 'Schule Nord/a.pdf')]

      await user.upload(screen.getByTestId('create-project-folder-input'), files)

      expect(await screen.findByTestId('create-project-dropped')).toHaveTextContent('Folder “Schule Nord”: 1 file')
      expect(screen.getByLabelText('Project name')).toHaveValue('Schule Nord')
      await user.click(submit())
      await waitFor(() => expect(action).toHaveBeenCalledTimes(1))
      expect(sent().dropKey).toBe(DROP_KEY)
    })

    test('a dropped folder does not rename a project that already has a name', async () => {
      const user = userEvent.setup()
      render(<CreateProjectForm />)
      await user.type(screen.getByLabelText('Project name'), 'Mein Name')

      dropFiles(screen.getByTestId('create-project-drop'), [withPath(new File(['a'], 'a.pdf'), 'Ordner/a.pdf')])

      expect(await screen.findByTestId('create-project-dropped')).toBeInTheDocument()
      expect(screen.getByLabelText('Project name')).toHaveValue('Mein Name')
    })

    test('the held files are discarded when the dialog goes away without creating', async () => {
      const first = render(<CreateProjectForm />)
      dropFiles(screen.getByTestId('create-project-drop'), [withPath(new File(['a'], 'a.pdf'), 'Ordner/a.pdf')])
      await screen.findByTestId('create-project-dropped')

      first.unmount()

      expect(takeDroppedFiles(DROP_KEY)).toEqual([])
    })

    test('a file dragged over the dialog that it cannot take says so', () => {
      render(<CreateProjectForm />)
      const program = new File(['x'], 'Setup.exe', { type: 'application/x-msdownload' })

      fireEvent.dragEnter(screen.getByTestId('create-project-drop'), {
        dataTransfer: { types: ['Files'], files: [program], items: [{ kind: 'file', type: program.type }] },
      })

      expect(screen.getByTestId('create-project-drop-overlay')).toHaveTextContent('Some files are not a supported type')
    })

    test('the held files survive the form that created the project: the setup page takes them', async () => {
      const user = userEvent.setup()
      const first = render(<CreateProjectForm />)
      const file = withPath(new File(['a'], 'a.pdf'), 'Ordner/a.pdf')
      dropFiles(screen.getByTestId('create-project-drop'), [file])
      await screen.findByTestId('create-project-dropped')

      await user.click(submit())
      await waitFor(() => expect(action).toHaveBeenCalledTimes(1))
      first.unmount()

      expect(takeDroppedFiles(DROP_KEY)).toEqual([file])
      // The key goes with the creation, so the redirect sends only THIS project's setup page for them.
      expect(sent().dropKey).toBe(DROP_KEY)
    })

    test('sends no key when nothing was dropped', async () => {
      const user = userEvent.setup()
      render(<CreateProjectForm />)
      await user.type(screen.getByLabelText('Project name'), 'Leer')
      await user.click(submit())
      await waitFor(() => expect(action).toHaveBeenCalledTimes(1))
      expect(sent()).not.toHaveProperty('dropKey')
    })

    test('a create that throws lets go of the held files when the dialog goes', async () => {
      action.mockRejectedValue(new Error('network'))
      const user = userEvent.setup()
      const first = render(<CreateProjectForm />)
      dropFiles(screen.getByTestId('create-project-drop'), [withPath(new File(['a'], 'a.pdf'), 'Ordner/a.pdf')])
      await screen.findByTestId('create-project-dropped')

      await user.click(submit())
      await waitFor(() => expect(action).toHaveBeenCalledTimes(1))
      first.unmount()

      // Held on, they would have been filed in the next project waiting for documents.
      expect(takeDroppedFiles(DROP_KEY)).toEqual([])
    })

    test('a create that throws says so calmly and lets the person try again', async () => {
      action.mockRejectedValueOnce(new Error('network'))
      const user = userEvent.setup()
      render(<CreateProjectForm />)
      await user.type(screen.getByLabelText('Project name'), 'Seestadt')
      await user.click(submit())
      expect(await screen.findByText(/couldn't create this project/)).toBeInTheDocument()
      expect(submit()).toBeEnabled()
    })
  })

  describe('no setup question', () => {
    test('the dialog asks nothing about who sets the project up: the setup page does both', async () => {
      const user = userEvent.setup()
      render(<CreateProjectForm />)

      // The only choice is the project's state.
      expect(screen.getAllByRole('radio').map((radio) => radio.textContent)).toEqual(['Ongoing', 'Closed, as a reference'])
      expect(screen.queryByRole('button', { name: /myself/i })).toBeNull()

      await user.type(screen.getByLabelText('Project name'), 'Villa K')
      await user.click(submit())
      await waitFor(() => expect(action).toHaveBeenCalledTimes(1))
      expect(sent()).toEqual({ name: 'Villa K', state: 'active', setup: 'piloti' })
    })
  })
})

/** A file as a folder drop gives it: with the path it had in the dropped tree. */
function withPath(file: File, path: string): File {
  Object.defineProperty(file, 'webkitRelativePath', { value: path, configurable: true })
  return file
}

/** A drag from the desktop onto `target`: `Files` in `types` is what marks it as an upload. */
function dropFiles(target: HTMLElement, files: File[]): void {
  fireEvent.drop(target, { dataTransfer: { types: ['Files'], files, items: [] } })
}

describe('folderNameOf', () => {
  test('is the top folder of a dropped tree', () => {
    expect(folderNameOf([withPath(new File([''], 'a.pdf'), 'Wohnbau Nord/03/a.pdf')])).toBe('Wohnbau Nord')
  })

  test('is a lone archive\'s name without its extension', () => {
    expect(folderNameOf([new File([''], 'Schule Nord.zip')])).toBe('Schule Nord')
  })

  test('is nothing for loose files', () => {
    expect(folderNameOf([new File([''], 'a.pdf'), new File([''], 'b.pdf')])).toBeNull()
  })
})
