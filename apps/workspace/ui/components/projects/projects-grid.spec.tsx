import { render, screen, within } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { vi, describe, test, expect } from 'vitest'
import { ProjectsGrid } from './projects-grid'
import type { Project } from '@/lib/db/schema/projects'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/app/projects',
}))

// The create dialog pulls in a server action via its form; grid behaviour
// under test does not depend on it.
vi.mock('./create-project-form', () => ({
  CreateProjectForm: () => <div data-testid="create-project-form" />,
}))

const createProject = (overrides: Partial<Project> = {}): Project =>
  ({
    id: 'proj-1',
    organizationId: 'org-1',
    name: 'Alpha Project',
    collectionName: 'proj_alpha',
    createdBy: 'user-1',
    workosResourceId: null,
    status: 'active',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  }) as Project

describe('ProjectsGrid', () => {
  test('renders the header row with title, search, and the New project action', () => {
    render(
      <ProjectsGrid
        projects={[createProject()]}
        docCounts={{}}
      />,
    )

    expect(screen.getByRole('heading', { level: 1, name: 'Projects' })).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: /search projects/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /new project/i })).toBeInTheDocument()
  })

  test('filters the grid client-side by name and can clear a no-match search', async () => {
    render(
      <ProjectsGrid
        projects={[
          createProject({ id: 'p1', name: 'Wohnbau Seestadt' }),
          createProject({ id: 'p2', name: 'Betriebsbau Linz' }),
        ]}
        docCounts={{}}
      />,
    )

    const search = screen.getByRole('textbox', { name: /search projects/i })
    await userEvent.type(search, 'seestadt')
    expect(screen.getByRole('link', { name: 'Open Wohnbau Seestadt' })).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Open Betriebsbau Linz' })).not.toBeInTheDocument()

    await userEvent.clear(search)
    await userEvent.type(search, 'zzz-no-such-project')
    expect(screen.getByText('No matching projects')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: /clear search/i }))
    expect(screen.getByRole('link', { name: 'Open Wohnbau Seestadt' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Open Betriebsbau Linz' })).toBeInTheDocument()
  })

  test('shows the first-project empty state (no search field) when there are no projects', () => {
    render(<ProjectsGrid projects={[]} docCounts={{}} />)

    expect(screen.getByText('Start your first project')).toBeInTheDocument()
    expect(screen.queryByRole('textbox', { name: /search projects/i })).not.toBeInTheDocument()
    // One way to create it: a header „New project" beside „Create your first
    // project" read as two different actions in a pilot onboarding.
    expect(screen.getByRole('button', { name: 'Create your first project' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'New project' })).not.toBeInTheDocument()
  })

  test('puts the three projects the viewer worked in most recently on the rail, the rest in the list', () => {
    render(
      <ProjectsGrid
        projects={[
          createProject({ id: 'p1', name: 'Seestadt' }),
          createProject({ id: 'p2', name: 'Grinzing' }),
          createProject({ id: 'p3', name: 'Lände 3' }),
          createProject({ id: 'p4', name: 'Semmering' }),
          createProject({ id: 'p5', name: 'Floridsdorf' }),
        ]}
        docCounts={{}}
        viewerActivity={{
          p4: '2026-08-03T09:00:00Z',
          p2: '2026-08-05T09:00:00Z',
          p1: '2026-08-04T09:00:00Z',
        }}
      />,
    )

    expect(screen.getByRole('heading', { level: 2, name: 'Pick up where you left off' })).toBeInTheDocument()

    // The rail is the only place with headings; the list is <li> rows.
    expect(screen.getAllByRole('heading', { level: 3 }).map((node) => node.textContent)).toEqual([
      'Grinzing',
      'Seestadt',
      'Semmering',
    ])
    expect(screen.getAllByRole('listitem')).toHaveLength(2)
    expect(screen.getByRole('heading', { level: 2, name: 'More projects' })).toBeInTheDocument()
  })

  test('fills the rail with any three projects, and says so, when the viewer has no activity', () => {
    render(
      <ProjectsGrid
        projects={[
          createProject({ id: 'p1', name: 'Older', createdAt: new Date('2026-01-01T00:00:00Z') }),
          createProject({ id: 'p2', name: 'Newer', createdAt: new Date('2026-05-01T00:00:00Z') }),
        ]}
        docCounts={{}}
      />,
    )

    expect(screen.getByRole('heading', { level: 2, name: 'Your projects' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Pick up where you left off' })).not.toBeInTheDocument()
    expect(screen.getAllByRole('heading', { level: 3 }).map((node) => node.textContent)).toEqual([
      'Newer',
      'Older',
    ])
    // Fewer projects than rail slots — no list section at all.
    expect(screen.queryByRole('listitem')).not.toBeInTheDocument()
  })

  test('collapses the rail into a single result list while searching', async () => {
    render(
      <ProjectsGrid
        projects={[
          createProject({ id: 'p1', name: 'Wohnbau Seestadt' }),
          createProject({ id: 'p2', name: 'Wohnbau Linz' }),
          createProject({ id: 'p3', name: 'Betriebsbau Graz' }),
          createProject({ id: 'p4', name: 'Hotel Semmering' }),
        ]}
        docCounts={{}}
        viewerActivity={{ p1: '2026-08-05T09:00:00Z' }}
      />,
    )

    await userEvent.type(screen.getByRole('textbox', { name: /search projects/i }), 'wohnbau')

    expect(screen.getByRole('heading', { level: 2, name: 'Matches' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Pick up where you left off' })).not.toBeInTheDocument()
    // Both matches are rows, including the one that was on the rail a moment ago.
    expect(screen.getAllByRole('listitem')).toHaveLength(2)
    expect(screen.queryByRole('heading', { level: 3 })).not.toBeInTheDocument()
  })

  test('finds a project by what an architect remembers: street, Gemeinde, client', async () => {
    const seestadt = createProject({
      id: 'p1',
      name: 'Wohnbau D12',
      profileDisplay: {
        title: 'Wohnbau D12',
        summary: 'Wohnbau · GK 5 · Wien',
        keyFacts: [{ label: 'Bauherr', value: 'Gemeinnützige Siedlungsgenossenschaft' }],
        missingInfo: [],
      },
      profile: {
        facts: {
          A1: {
            value: 'Janis-Joplin-Promenade 12, 1220 Wien',
            confidence: 'confirmed',
            source: 'user_confirmed',
            updatedAt: '2026-01-01T00:00:00Z',
          },
        },
        goals: {},
        unknowns: [],
        assumptions: {},
      },
    })
    render(
      <ProjectsGrid
        projects={[seestadt, createProject({ id: 'p2', name: 'Turnsaal Linz' })]}
        docCounts={{}}
      />,
    )
    const search = screen.getByRole('textbox', { name: /search projects/i })

    await userEvent.type(search, 'joplin')
    expect(screen.getByRole('link', { name: 'Open Wohnbau D12' })).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Open Turnsaal Linz' })).not.toBeInTheDocument()

    await userEvent.clear(search)
    await userEvent.type(search, 'siedlungsgenossenschaft')
    expect(screen.getByRole('link', { name: 'Open Wohnbau D12' })).toBeInTheDocument()
  })

  test('the search can be reset from the field itself, with a control a thumb can hit', async () => {
    render(<ProjectsGrid projects={[createProject({ name: 'Seestadt' })]} docCounts={{}} />)
    const search = screen.getByRole('textbox', { name: /search projects/i })
    await userEvent.type(search, 'zzz')

    const reset = screen.getByRole('button', { name: 'Reset search' })
    expect(reset).toHaveClass('pointer-coarse:size-11')
    await userEvent.click(reset)
    expect(search).toHaveValue('')
  })

  test('keeps the title and the New project action on one line, with the search on its own below on a phone', () => {
    render(<ProjectsGrid projects={[createProject()]} docCounts={{}} />)

    const header = screen.getByRole('heading', { level: 1, name: 'Projects' }).parentElement
    // The action cannot be clipped by a full-width search beside it: they are
    // placed in different grid rows below `sm`.
    expect(header).toHaveClass('grid')
    const search = screen.getByRole('textbox', { name: /search projects/i }).closest('.col-span-2')
    expect(search).toHaveClass('row-start-2', 'sm:col-start-2', 'sm:row-start-1')
  })

  test('the resume rail is one swipeable row on a phone (upright or on its side) and a grid on a tall screen from sm', () => {
    render(
      <ProjectsGrid
        projects={[createProject({ id: 'p1', name: 'A' }), createProject({ id: 'p2', name: 'B' })]}
        docCounts={{}}
      />,
    )
    const rail = screen.getByTestId('projects-resume-rail')
    expect(rail).toHaveClass('snap-x', 'overflow-x-auto', 'sm:[@media(min-height:32rem)]:grid')
  })

  describe('the status filter (ADR-0098, ADR-0090)', () => {
    const closed = (id: string, name: string): Project =>
      createProject({ id, name, status: 'closed', closedAt: new Date('2026-09-01T00:00:00Z'), closedBy: 'u' })

    test('is not offered while no project is closed', () => {
      render(<ProjectsGrid projects={[createProject({ id: 'p1', name: 'Seestadt' })]} docCounts={{}} />)
      expect(screen.queryByTestId('project-status-filter')).not.toBeInTheDocument()
    })

    test('opens on the active projects, with closed ones a click away, chip and all', async () => {
      render(
        <ProjectsGrid
          projects={[createProject({ id: 'p1', name: 'Seestadt', status: 'active' }), closed('p2', 'Volksschule Grinzing')]}
          docCounts={{}}
        />,
      )

      expect(screen.getByRole('link', { name: 'Open Seestadt' })).toBeInTheDocument()
      expect(screen.queryByRole('link', { name: 'Open Volksschule Grinzing' })).not.toBeInTheDocument()

      await userEvent.click(screen.getByTestId('project-status-filter-closed'))
      expect(screen.getByRole('link', { name: 'Open Volksschule Grinzing' })).toBeInTheDocument()
      expect(screen.queryByRole('link', { name: 'Open Seestadt' })).not.toBeInTheDocument()
      expect(screen.getAllByText('Closed').length).toBeGreaterThan(0)

      await userEvent.click(screen.getByTestId('project-status-filter-all'))
      expect(screen.getByRole('link', { name: 'Open Seestadt' })).toBeInTheDocument()
      expect(screen.getByRole('link', { name: 'Open Volksschule Grinzing' })).toBeInTheDocument()
    })

    test('offers Ruhend only when a project is paused, and keeps paused and closed projects off the rail', async () => {
      render(
        <ProjectsGrid
          projects={[
            createProject({ id: 'p1', name: 'Seestadt', status: 'active' }),
            createProject({ id: 'p2', name: 'Hotel Semmering', status: 'paused', pausedAt: new Date() }),
            closed('p3', 'Volksschule Grinzing'),
          ]}
          docCounts={{}}
          viewerActivity={{ p2: new Date().toISOString(), p3: new Date().toISOString() }}
        />,
      )

      expect(screen.getByTestId('project-status-filter-paused')).toBeInTheDocument()
      await userEvent.click(screen.getByTestId('project-status-filter-all'))
      // The viewer worked in the paused and the closed project last, and still
      // the rail is the active one alone: it is for work in progress.
      const rail = screen.getByRole('region', { name: 'Your projects' })
      expect(within(rail).getByRole('link', { name: 'Open Seestadt' })).toBeInTheDocument()
      expect(within(rail).queryByRole('link', { name: 'Open Hotel Semmering' })).not.toBeInTheDocument()
      expect(within(screen.getByRole('region', { name: 'More projects' })).getByText('Paused')).toBeInTheDocument()

      await userEvent.click(screen.getByTestId('project-status-filter-paused'))
      expect(screen.getByRole('link', { name: 'Open Hotel Semmering' })).toBeInTheDocument()
      expect(screen.queryByRole('link', { name: 'Open Seestadt' })).not.toBeInTheDocument()
      expect(screen.queryByRole('region', { name: 'Your projects' })).not.toBeInTheDocument()
    })

    test('leaves out a segment with nothing in it', () => {
      render(
        <ProjectsGrid projects={[createProject({ id: 'p1', name: 'Seestadt' }), closed('p2', 'Lände 3')]} docCounts={{}} />,
      )
      expect(screen.queryByTestId('project-status-filter-paused')).not.toBeInTheDocument()
      expect(screen.getByTestId('project-status-filter-closed')).toBeInTheDocument()
    })

    test('opens on all of them when nothing is active', () => {
      render(<ProjectsGrid projects={[closed('p1', 'Lände 3')]} docCounts={{}} />)
      expect(screen.getByRole('link', { name: 'Open Lände 3' })).toBeInTheDocument()
    })
  })
})
