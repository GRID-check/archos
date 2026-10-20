/**
 * Creating a project, running or already closed: what reaches the server
 * action, and what keeps the submit shut. And the setup: the address (a
 * combobox over the address search, or the Bundesland when there is none),
 * „Worum geht es?", Piloti or the person setting it up, and a project folder
 * dropped on the dialog.
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
    takeDroppedFiles('new-project')
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

  test('a closed project needs its outcome, then sends outcome, start and closing', async () => {
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

  test('sends a chosen start', async () => {
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

  test('a closing in the future shows the error and keeps the submit shut', async () => {
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

  test("the server's closing reason lands on the closing field, not in a general alert", async () => {
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

    test('the drag-a-folder hint, which a touch screen cannot act on, is hidden there', () => {
      render(<CreateProjectForm />)
      expect(screen.getByTestId('create-project-drop-hint')).toHaveClass('pointer-coarse:hidden')
    })
  })

  describe('Piloti sets it up', () => {
    test('a chosen address is sent as the location, with „Worum geht es?"', async () => {
      search.mockResolvedValue({ enabled: true, results: [hauptstrasse, moedling] } satisfies GeocodeResponse)
      const user = userEvent.setup()
      render(<CreateProjectForm />)

      await user.type(screen.getByLabelText('Project name'), 'Aufstockung')
      await user.type(screen.getByRole('textbox', { name: 'What is it about?' }), 'Zwei Geschoße mehr')
      await user.type(screen.getByRole('combobox', { name: 'Address' }), 'Hauptstraße')
      await user.click(await screen.findByRole('option', { name: /Hauptstraße 12, 1010 Wien/ }))

      // The chosen hit names its Gemeinde and Bundesland.
      expect(screen.getByTestId('create-project-address-chosen')).toHaveTextContent('Wien · Wien')
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
      expect(screen.getByTestId('create-project-address-chosen')).toHaveTextContent('Hauptstraße 3, 2340 Mödling')
      expect(screen.getByTestId('create-project-address-chosen')).toHaveTextContent('Mödling · Niederösterreich')
      expect(action).not.toHaveBeenCalled()
    })

    test('says so when the address has no match, and still creates the project without one', async () => {
      search.mockResolvedValue({ enabled: true, results: [] } satisfies GeocodeResponse)
      const user = userEvent.setup()
      render(<CreateProjectForm />)

      await user.type(screen.getByLabelText('Project name'), 'Wettbewerb')
      await user.type(screen.getByRole('combobox', { name: 'Address' }), 'Nirgendwo')
      expect(await screen.findByText(/No match/)).toBeInTheDocument()
      await user.click(submit())

      await waitFor(() => expect(action).toHaveBeenCalledTimes(1))
      expect(sent()).toEqual({ name: 'Wettbewerb', state: 'active', setup: 'piloti' })
    })

    test('with no geocoder configured, the Bundesland is a select and is sent', async () => {
      search.mockResolvedValue({ enabled: false, results: [] } satisfies GeocodeResponse)
      const user = userEvent.setup()
      render(<CreateProjectForm />)

      await user.type(screen.getByLabelText('Project name'), 'Haus am See')
      await user.type(screen.getByRole('combobox', { name: 'Address' }), 'Seestraße')

      const select = await screen.findByRole('combobox', { name: 'Bundesland' })
      expect(screen.queryByRole('combobox', { name: 'Address' })).toBeNull()
      await user.click(select)
      expect(screen.queryByRole('option', { name: 'Außerhalb Österreichs' })).toBeNull()
      await user.click(await screen.findByRole('option', { name: 'Kärnten' }))
      await user.click(submit())

      await waitFor(() => expect(action).toHaveBeenCalledTimes(1))
      expect(sent()).toEqual({ name: 'Haus am See', state: 'active', setup: 'piloti', bundesland: 'kaernten' })
    })

    test('remembers that there is no geocoder, so the next dialog opens as the select', async () => {
      search.mockResolvedValue({ enabled: false, results: [] } satisfies GeocodeResponse)
      const user = userEvent.setup()
      const first = render(<CreateProjectForm />)
      await user.type(screen.getByRole('combobox', { name: 'Address' }), 'Seestraße')
      await screen.findByRole('combobox', { name: 'Bundesland' })
      first.unmount()

      render(<CreateProjectForm />)
      expect(screen.getByRole('combobox', { name: 'Bundesland' })).toBeInTheDocument()
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
      expect(takeDroppedFiles('new-project')).toEqual(files)
      // Taken once: put it back for the rest of the test.
      await user.click(screen.getByRole('button', { name: 'Remove the folder' }))
      expect(screen.queryByTestId('create-project-dropped')).toBeNull()
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

      expect(takeDroppedFiles('new-project')).toEqual([])
    })

    test('choosing to fill it in oneself lets go of the held folder: it would be filed in the next project', async () => {
      const user = userEvent.setup()
      const first = render(<CreateProjectForm />)
      dropFiles(screen.getByTestId('create-project-drop'), [withPath(new File(['a'], 'a.pdf'), 'Ordner/a.pdf')])
      await screen.findByTestId('create-project-dropped')

      await user.click(screen.getByRole('radio', { name: /Fill it in myself/ }))
      expect(screen.queryByTestId('create-project-dropped')).toBeNull()
      expect(takeDroppedFiles('new-project')).toEqual([])

      // And nothing is held for the setup page after the project is created.
      await user.click(submit())
      await waitFor(() => expect(action).toHaveBeenCalledTimes(1))
      first.unmount()
      expect(takeDroppedFiles('new-project')).toEqual([])
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

      expect(takeDroppedFiles('new-project')).toEqual([file])
    })
  })

  describe('Selbst ausfüllen', () => {
    test('is today: no address, no description, no setup fields, the old closed label', async () => {
      const user = userEvent.setup()
      render(<CreateProjectForm />)

      await user.type(screen.getByLabelText('Project name'), 'Villa K')
      await user.click(screen.getByRole('radio', { name: /Fill it in myself/ }))
      await user.click(submit())

      await waitFor(() => expect(action).toHaveBeenCalledTimes(1))
      expect(sent()).toEqual({ name: 'Villa K', state: 'active', setup: 'self' })
      expect(capturePosthog).toHaveBeenCalledWith('project_created', { state: 'active', setup: 'self' })
    })

    test('a typed description is left out of what is sent', async () => {
      const user = userEvent.setup()
      render(<CreateProjectForm />)

      await user.type(screen.getByLabelText('Project name'), 'Villa K')
      await user.type(screen.getByRole('textbox', { name: 'What is it about?' }), 'ignored')
      await user.click(screen.getByRole('radio', { name: /Fill it in myself/ }))
      await user.click(submit())

      await waitFor(() => expect(action).toHaveBeenCalledTimes(1))
      expect(sent()).not.toHaveProperty('description')
    })

    test('a closed project is created closed at once, with the old label', async () => {
      const user = userEvent.setup()
      render(<CreateProjectForm />)

      await user.type(screen.getByLabelText('Project name'), 'Schule Nord')
      await user.click(screen.getByRole('radio', { name: /Fill it in myself/ }))
      await user.click(screen.getByRole('radio', { name: /^Closed/ }))
      await user.click(await screen.findByRole('radio', { name: /Completed/ }))
      expect(screen.getByTestId('create-project-closed-note')).toHaveTextContent('A closed project is read-only.')
      await user.click(submit(/^Create closed project$/))

      await waitFor(() => expect(action).toHaveBeenCalledTimes(1))
      expect(sent()).toMatchObject({ setup: 'self', state: 'closed', outcome: 'completed' })
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
