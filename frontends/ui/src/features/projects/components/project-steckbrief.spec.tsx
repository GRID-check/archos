/**
 * The Steckbrief tile and its editor (ADR-0091): the tile summarizes, the
 * dialog edits; members are listed without being typed in, only people
 * without an account are added, and the editor offers only what the server
 * allows and sends months and nothing more.
 */
import { render, screen, within } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { ProjectPersonView, SteckbriefView } from '@/lib/projects/steckbrief-types'
import { ProjectSteckbrief } from './project-steckbrief'

const refresh = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh, push: vi.fn(), replace: vi.fn() }) }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

const person = (overrides: Partial<ProjectPersonView>): ProjectPersonView => ({
  id: 'person-1',
  kind: 'added',
  userId: null,
  name: 'DI Maria Huber',
  function: 'Statik',
  company: 'Huber ZT GmbH',
  startedOn: '2023-03',
  endedOn: '2025-11',
  ...overrides,
})

const MEMBER = person({ id: null, kind: 'member', userId: 'user-ab', name: 'Andreas Berger', function: null, company: null, startedOn: '2023-04', endedOn: null })
const FORMER = person({ id: 'person-ls', kind: 'former', userId: 'user-ls', name: 'Lukas Steiner', function: 'Einreichplanung', company: null })

const view = (overrides: Partial<SteckbriefView> = {}): SteckbriefView => ({
  address: 'Seestadtstraße 12, 1220 Wien',
  startedOn: '2023-03',
  startedOnIsDefault: false,
  endedOn: null,
  people: [MEMBER, person({}), FORMER],
  rosterKnown: true,
  canEdit: true,
  canErase: true,
  ...overrides,
})

const openEditor = async (name = 'Edit'): Promise<HTMLElement> => {
  await userEvent.click(screen.getByRole('button', { name }))
  return screen.findByTestId('steckbrief-dialog')
}

describe('ProjectSteckbrief', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    refresh.mockClear()
  })

  test('the tile: the period as its figure, the address, and who was involved, former members marked', () => {
    render(<ProjectSteckbrief projectId="p1" steckbrief={view()} />)
    expect(screen.getByTestId('steckbrief-period')).toHaveTextContent('since Mar 2023')
    expect(screen.getByTestId('steckbrief-address')).toHaveTextContent('Seestadtstraße 12, 1220 Wien')
    const people = screen.getByRole('region', { name: 'People involved' })
    expect(within(people).getByText('Andreas Berger')).toBeInTheDocument()
    expect(within(people).getByText('Statik · Huber ZT GmbH')).toBeInTheDocument()
    expect(within(people).getByText('former')).toBeInTheDocument()
    expect(screen.getByText('3 people · 1 former')).toBeInTheDocument()
    // Nothing is edited on the dashboard.
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  })

  test('a closed project reads its whole period', () => {
    render(<ProjectSteckbrief projectId="p1" steckbrief={view({ endedOn: '2026-10', canEdit: false })} />)
    expect(screen.getByTestId('steckbrief-period')).toHaveTextContent('Mar 2023 – Oct 2026')
  })

  test('a reader who may change nothing gets no control, unless the tile cannot name everyone', () => {
    const { unmount } = render(<ProjectSteckbrief projectId="p1" steckbrief={view({ canEdit: false, canErase: false })} />)
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
    unmount()

    const many = Array.from({ length: 8 }, (_, index) => person({ id: `p${index}`, name: `Person ${index}` }))
    render(<ProjectSteckbrief projectId="p1" steckbrief={view({ people: many, canEdit: false, canErase: false })} />)
    expect(screen.getByText('2 more people')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Show all' })).toBeInTheDocument()
  })

  test('a closed project: nothing to add or edit, but a manager may still erase a person', async () => {
    render(<ProjectSteckbrief projectId="p1" steckbrief={view({ canEdit: false, canErase: true })} />)
    const dialog = await openEditor('Show all')
    expect(within(dialog).queryByRole('button', { name: 'Add person' })).not.toBeInTheDocument()
    expect(within(dialog).queryByRole('button', { name: /^Edit / })).not.toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'Remove DI Maria Huber' })).toBeInTheDocument()
  })

  test('a member is listed on their own and cannot be removed from the record; their Funktion is open until set', async () => {
    render(<ProjectSteckbrief projectId="p1" steckbrief={view()} />)
    const dialog = await openEditor()
    const member = within(dialog).getAllByTestId('steckbrief-person')[0]
    expect(within(member).getByText('Member')).toBeInTheDocument()
    expect(within(member).getByText(/Function open/)).toBeInTheDocument()
    expect(within(dialog).queryByRole('button', { name: 'Remove Andreas Berger' })).not.toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'Remove Lukas Steiner' })).toBeInTheDocument()
  })

  test('describing a member writes their first row, keyed by their account, with the name their account has', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 201 }))
    vi.stubGlobal('fetch', fetchMock)
    render(<ProjectSteckbrief projectId="p1" steckbrief={view()} />)
    const dialog = await openEditor()

    await userEvent.click(within(dialog).getByRole('button', { name: 'Edit Andreas Berger' }))
    expect(within(dialog).queryByLabelText('Name')).not.toBeInTheDocument()
    await userEvent.type(within(dialog).getByLabelText('Function'), 'Bauleitung')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }))

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/projects/p1/people',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          name: 'Andreas Berger',
          function: 'Bauleitung',
          company: '',
          startedOn: '2023-04',
          endedOn: null,
          userId: 'user-ab',
        }),
      })
    )
    expect(refresh).toHaveBeenCalled()
  })

  test('adds someone without an account, choosing months from the pickers, and no contact details', async () => {
    const user = userEvent.setup()
    const fetchMock = vi.fn(async () => new Response('{}', { status: 201 }))
    vi.stubGlobal('fetch', fetchMock)
    render(<ProjectSteckbrief projectId="p1" steckbrief={view({ people: [] })} />)
    const dialog = await openEditor()

    await user.click(within(dialog).getByRole('button', { name: 'Add person' }))
    await user.type(within(dialog).getByLabelText('Name'), 'Anna Weber')
    await user.type(within(dialog).getByLabelText('Function'), 'Bauherr')
    const from = within(dialog).getAllByRole('combobox', { name: 'Month' })[1]
    await user.click(from)
    await user.click(await screen.findByRole('option', { name: 'March' }))
    await user.click(within(dialog).getAllByRole('combobox', { name: 'Year' })[1])
    await user.click(await screen.findByRole('option', { name: '2023' }))
    await user.click(within(dialog).getByRole('button', { name: 'Save' }))

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/projects/p1/people',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          name: 'Anna Weber',
          function: 'Bauherr',
          company: '',
          startedOn: '2023-03',
          endedOn: null,
          userId: null,
        }),
      })
    )
  })

  test('erases a person after one confirmation', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetchMock)
    render(<ProjectSteckbrief projectId="p1" steckbrief={view()} />)
    const dialog = await openEditor()

    await userEvent.click(within(dialog).getByRole('button', { name: 'Remove DI Maria Huber' }))
    expect(fetchMock).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole('button', { name: 'Remove for good' }))
    expect(fetchMock).toHaveBeenCalledWith('/api/projects/p1/people/person-1', expect.objectContaining({ method: 'DELETE' }))
  })

  test('a running project edits its Beginn alone, saved when chosen; the Abschluss is the closing\'s (ADR-0098)', async () => {
    const user = userEvent.setup()
    const fetchMock = vi.fn(async () => Response.json({ startedOn: '2023-01' }))
    vi.stubGlobal('fetch', fetchMock)
    render(<ProjectSteckbrief projectId="p1" steckbrief={view({ startedOnIsDefault: true })} />)
    const dialog = await openEditor()

    expect(within(dialog).getByText(/The month the project was created in Piloti/)).toBeInTheDocument()
    expect(within(dialog).getByTestId('steckbrief-end')).toHaveTextContent('Ongoing.')
    await user.click(within(dialog).getAllByRole('combobox', { name: 'Month' })[0])
    await user.click(await screen.findByRole('option', { name: 'January' }))
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/projects/p1/steckbrief',
      expect.objectContaining({ method: 'PUT', body: JSON.stringify({ startedOn: '2023-01' }) })
    )
  })

  test('says when the roster could not be read, rather than calling anyone former', async () => {
    render(<ProjectSteckbrief projectId="p1" steckbrief={view({ rosterKnown: false })} />)
    const dialog = await openEditor()
    expect(within(dialog).getByText(/could not be loaded just now/)).toBeInTheDocument()
  })
})
