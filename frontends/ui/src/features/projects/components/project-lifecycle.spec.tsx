/**
 * The project lifecycle in the UI (ADR-0098, ADR-0090): the banner a paused or
 * closed project opens every page with, and the status card's moves.
 */
import { render, screen, within } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { ProjectLifecycleView } from '@/lib/projects/project-status'
import { CurrentProjectProvider, type CurrentProject } from '../lib/current-project'
import { ProjectStatusBanner } from './project-status-banner'
import { ProjectLifecycleCard } from './project-lifecycle-card'

const refresh = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh, push: vi.fn(), replace: vi.fn() }) }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

const ACTIVE: ProjectLifecycleView = {
  status: 'active',
  pausedAt: null,
  closedAt: null,
  closedOutcome: null,
  endedOn: null,
  startedOn: '2023-04',
  suggestedEndedOn: null,
  suggestedOutcome: null,
}
const CLOSED: ProjectLifecycleView = {
  ...ACTIVE,
  status: 'closed',
  closedAt: '2026-10-06T10:00:00Z',
  closedOutcome: 'completed',
  endedOn: '2026-09',
}
const PAUSED: ProjectLifecycleView = { ...ACTIVE, status: 'paused', pausedAt: '2026-08-14T10:00:00Z' }

const project = (overrides: Partial<CurrentProject> = {}): CurrentProject => ({
  id: 'p1',
  name: 'Seestadt D12',
  status: 'closed',
  closedAt: '2026-10-06T10:00:00Z',
  readsBecauseClosed: false,
  lifecycle: CLOSED,
  ...overrides,
})

const statusPuts = (fetchMock: ReturnType<typeof vi.fn>) =>
  fetchMock.mock.calls
    .filter(([url, init]) => url === '/api/projects/p1/status' && (init as RequestInit | undefined)?.method === 'PUT')
    .map(([, init]) => JSON.parse(String((init as RequestInit).body)))

describe('ProjectStatusBanner', () => {
  afterEach(() => vi.unstubAllGlobals())

  test('says the project is closed, since when, and that it is read-only', () => {
    render(
      <CurrentProjectProvider value={project()}>
        <ProjectStatusBanner />
      </CurrentProjectProvider>
    )
    expect(screen.getByText('Closed project · read-only')).toBeInTheDocument()
    // When the work ended leads; the day it was closed in Piloti follows.
    expect(screen.getByTestId('closed-project-banner')).toHaveTextContent('Completed September 2026. Closed in Piloti on October 6, 2026.')
    expect(screen.getByTestId('closed-project-banner')).toHaveAttribute('role', 'status')
    expect(screen.getByTestId('closed-project-banner')).not.toHaveTextContent('closed projects are readable by the whole office')
    expect(screen.getByTestId('closed-project-banner')).not.toHaveTextContent('not realized')
    // Nobody here may reopen it, so nothing offers to.
    expect(screen.queryByRole('button', { name: 'Reopen project' })).not.toBeInTheDocument()
  })

  test('says a project was not realized', () => {
    render(
      <CurrentProjectProvider value={project({ lifecycle: { ...CLOSED, closedOutcome: 'cancelled' } })}>
        <ProjectStatusBanner />
      </CurrentProjectProvider>
    )
    expect(screen.getByTestId('closed-project-banner')).toHaveTextContent('It was not realized.')
  })

  test('tells someone who reads it only because it is closed why, and that restricted folders stay hidden', () => {
    render(
      <CurrentProjectProvider value={project({ readsBecauseClosed: true })}>
        <ProjectStatusBanner />
      </CurrentProjectProvider>
    )
    expect(screen.getByTestId('closed-project-banner')).toHaveTextContent('Folders with their own access list stay hidden from you.')
  })

  test('offers whoever may move it the way out: reopening asks first', async () => {
    const fetchMock = vi.fn(async () => Response.json({}))
    vi.stubGlobal('fetch', fetchMock)
    render(
      <CurrentProjectProvider value={project({ canChangeStatus: true })}>
        <ProjectStatusBanner />
      </CurrentProjectProvider>
    )
    await userEvent.click(screen.getByRole('button', { name: 'Reopen project' }))
    expect(statusPuts(fetchMock)).toEqual([])
    await userEvent.click(screen.getByRole('button', { name: 'Reopen' }))
    expect(statusPuts(fetchMock)).toEqual([{ status: 'active' }])
  })

  test('a paused project: since when, still editable, and resumed in one click', async () => {
    const fetchMock = vi.fn(async () => Response.json({}))
    vi.stubGlobal('fetch', fetchMock)
    render(
      <CurrentProjectProvider value={project({ status: 'paused', closedAt: null, lifecycle: PAUSED, canChangeStatus: true })}>
        <ProjectStatusBanner />
      </CurrentProjectProvider>
    )
    const banner = screen.getByTestId('paused-project-banner')
    expect(banner).toHaveTextContent('Paused since August 14, 2026.')
    expect(banner).toHaveTextContent('Everything stays editable.')
    await userEvent.click(within(banner).getByRole('button', { name: 'Resume' }))
    expect(statusPuts(fetchMock)).toEqual([{ status: 'active' }])
    expect(refresh).toHaveBeenCalled()
  })

  test('renders nothing for an active project, or outside one', () => {
    const { container } = render(
      <CurrentProjectProvider value={project({ status: 'active', closedAt: null, lifecycle: ACTIVE })}>
        <ProjectStatusBanner />
      </CurrentProjectProvider>
    )
    expect(container).toBeEmptyDOMElement()
    expect(render(<ProjectStatusBanner />).container).toBeEmptyDOMElement()
  })
})

describe('ProjectLifecycleCard', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    refresh.mockClear()
  })

  test('draws the three states with the current one marked', () => {
    render(<ProjectLifecycleCard projectId="p1" lifecycle={PAUSED} />)
    const track = screen.getByRole('list', { name: 'Project lifecycle' })
    expect(within(track).getAllByRole('listitem').map((item) => item.textContent)).toEqual(['Active', '⇄Paused', '→Closed'])
    expect(within(track).getByText('Paused')).toHaveAttribute('aria-current', 'step')
  })

  test('pauses an active project without asking, and offers no pause once paused', async () => {
    const fetchMock = vi.fn(async () => Response.json({}))
    vi.stubGlobal('fetch', fetchMock)
    const { rerender } = render(<ProjectLifecycleCard projectId="p1" lifecycle={ACTIVE} />)

    await userEvent.click(screen.getByRole('button', { name: 'Pause' }))
    expect(statusPuts(fetchMock)).toEqual([{ status: 'paused' }])
    expect(refresh).toHaveBeenCalled()

    rerender(<ProjectLifecycleCard projectId="p1" lifecycle={PAUSED} />)
    expect(screen.queryByRole('button', { name: 'Pause' })).not.toBeInTheDocument()
    expect(screen.getByText('Paused since August 14, 2026')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Resume' }))
    expect(statusPuts(fetchMock)).toEqual([{ status: 'paused' }, { status: 'active' }])
  })

  test('closing asks how it ended and when, then what stays, then the clear-out, and only then closes', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/cleanup')) return Response.json({ items: [], considered: 3, aiUsed: true, aiError: null })
      if (url.endsWith('/memory')) return Response.json({ items: [] })
      return Response.json({ status: 'closed' })
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<ProjectLifecycleCard projectId="p1" lifecycle={{ ...ACTIVE, suggestedEndedOn: '2025-06' }} />)

    await userEvent.click(screen.getByRole('button', { name: 'Close project' }))
    // Step one: the outcome and the Abschluss, an earlier close's month offered.
    expect(await screen.findByTestId('close-step-ending')).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: 'Completion' })).toHaveTextContent('June')
    expect(screen.getByRole('combobox', { name: 'Year' })).toHaveTextContent('2025')
    await userEvent.click(screen.getByRole('radio', { name: /Not realized/ }))
    await userEvent.click(screen.getByRole('button', { name: 'Next' }))
    // Step two: the debrief, which stays mounted (hidden) while another step shows.
    expect(await screen.findByTestId('closing-debrief')).toBeInTheDocument()
    expect(screen.getByTestId('close-step-keep')).toBeVisible()
    await userEvent.click(screen.getByRole('button', { name: 'Next' }))
    expect(screen.getByTestId('close-step-keep')).not.toBeVisible()
    expect(screen.getByTestId('closing-debrief')).toBeInTheDocument()
    // Step three: nothing to clear out, so one button closes.
    expect(await screen.findByText('Piloti proposes nothing to remove.')).toBeInTheDocument()
    expect(statusPuts(fetchMock)).toEqual([])
    await userEvent.click(screen.getByRole('button', { name: 'Close project' }))

    expect(statusPuts(fetchMock)).toEqual([{ status: 'closed', outcome: 'cancelled', endedOn: '2025-06' }])
    expect(refresh).toHaveBeenCalled()
  })

  test('a project whose start lies ahead closes in the start\'s month, and offers nothing earlier', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ items: [], considered: 0, aiUsed: false, aiError: null })))
    render(<ProjectLifecycleCard projectId="p1" lifecycle={{ ...ACTIVE, startedOn: '2099-01' }} />)

    await userEvent.click(screen.getByRole('button', { name: 'Close project' }))
    expect(await screen.findByRole('combobox', { name: 'Completion' })).toHaveTextContent('January')
    // Only the Beginn's year is offered: nothing earlier, and nothing later than it.
    await userEvent.click(screen.getByRole('combobox', { name: 'Year' }))
    expect((await screen.findAllByRole('option')).map((option) => option.textContent)).toEqual(['2099'])
    await userEvent.keyboard('{Escape}')
    // The outcome is chosen, never preselected: until then there is no going on.
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled()
    await userEvent.click(screen.getByRole('radio', { name: /Not realized/ }))
    expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled()
  })

  test('a closed project says how and when it ended, and offers to reopen it', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    render(<ProjectLifecycleCard projectId="p1" lifecycle={CLOSED} />)

    expect(screen.getByTestId('lifecycle-closed-facts')).toHaveTextContent('Completed · completion September 2026')
    expect(screen.getByText('Closed in Piloti on October 6, 2026')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Pause' })).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Reopen project' }))
    expect(screen.queryByTestId('closing-debrief')).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Reopen' }))
    expect(statusPuts(fetchMock)).toEqual([{ status: 'active' }])
  })
})
