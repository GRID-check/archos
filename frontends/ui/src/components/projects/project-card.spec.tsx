import { render, screen } from '@/test-utils'
import { describe, test, expect } from 'vitest'
import { ProjectCard } from './project-card'
import { getProjectStatus } from './project-status'
import type { Project } from '@/lib/db/schema/projects'

const createProject = (overrides: Partial<Project> = {}): Project =>
  ({
    id: 'proj-1',
    organizationId: 'org-1',
    name: 'Alpha Project',
    collectionName: 'proj_alpha_collection',
    createdBy: 'user-1',
    workosResourceId: 'res-1',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  }) as Project

describe('ProjectCard', () => {
  test('renders the project name and never leaks the internal collection name', () => {
    render(<ProjectCard project={createProject({ name: 'Alpha', collectionName: 'proj_secret' })} />)

    expect(screen.getByText('Alpha')).toBeInTheDocument()
    expect(screen.queryByText('proj_secret')).not.toBeInTheDocument()
  })

  test('links into the project Chat — the project landing surface', () => {
    // The card face mirrors the click-dummy (name · summary · last activity) and
    // deliberately omits the doc count; docCount stays a no-op prop for callers.
    render(<ProjectCard project={createProject({ id: 'proj-abc', name: 'Beta' })} docCount={3} />)

    expect(screen.getByRole('link', { name: /open beta/i })).toHaveAttribute(
      'href',
      '/app/projects/proj-abc/chat',
    )
  })

  test('carries a per-card link to the project overview, named for what it opens', () => {
    render(<ProjectCard project={createProject({ id: 'proj-abc', name: 'Beta' })} />)

    const overview = screen.getByRole('link', { name: /overview of beta/i })
    expect(overview).toHaveAttribute('href', '/app/projects/proj-abc/settings')
    expect(overview).toHaveTextContent('Overview')
    // 44px under a finger: the gear it replaced was 30px.
    expect(overview).toHaveClass('pointer-coarse:h-11')
  })

  test('carries no status chip while the project is active: the normal case says nothing (ADR-0098)', () => {
    render(<ProjectCard project={createProject()} />)

    expect(screen.queryByText('Active')).not.toBeInTheDocument()
  })

  test('renders last activity as a relative time from the newest timestamp', () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 3600 * 1000)
    render(
      <ProjectCard
        project={createProject({
          createdAt: new Date('2026-01-01T00:00:00Z'),
          profileUpdatedAt: twoHoursAgo,
        })}
      />,
    )

    expect(screen.getByText('Last activity')).toBeInTheDocument()
    expect(screen.getByText('2 hours ago')).toBeInTheDocument()
  })

  /**
   * The resume rail renders THIS card — there is no second "big" project card.
   * What the rail adds is the viewer's own timestamp, and the card has to say
   * whose it is: "you were last here" and "this project last moved" are
   * different facts, and a card that showed one under the other's label would be
   * wrong in the one place people trust it most.
   */
  test('names the viewer’s own activity when the caller supplies it', () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 3600 * 1000)
    render(
      <ProjectCard
        project={createProject({ profileUpdatedAt: new Date('2020-01-01T00:00:00Z') })}
        activityAt={twoHoursAgo.toISOString()}
      />,
    )

    expect(screen.getByText('You were last here')).toBeInTheDocument()
    expect(screen.queryByText('Last activity')).not.toBeInTheDocument()
    // The viewer's timestamp wins over the project's own, which is far older here.
    expect(screen.getByText('2 hours ago')).toBeInTheDocument()
  })
})

describe('getProjectStatus', () => {
  test('reads the stored status (ADR-0098): active, paused, or closed', () => {
    expect(getProjectStatus({ status: 'active' })).toBe('active')
    expect(getProjectStatus({ status: 'paused' })).toBe('paused')
    expect(getProjectStatus({ status: 'closed' })).toBe('closed')
  })

  test('a closed project card says so, and says when it was not realized', () => {
    const { unmount } = render(
      <ProjectCard project={createProject({ status: 'closed', closedAt: new Date(), closedBy: 'u', closedOutcome: 'completed' })} docCount={0} />
    )
    expect(screen.getByText('Closed')).toBeInTheDocument()
    unmount()
    render(<ProjectCard project={createProject({ status: 'closed', closedAt: new Date(), closedBy: 'u', closedOutcome: 'cancelled' })} />)
    expect(screen.getByText('Not realized')).toBeInTheDocument()
  })

  test('a paused project card says so', () => {
    render(<ProjectCard project={createProject({ status: 'paused', pausedAt: new Date() })} />)
    expect(screen.getByText('Paused')).toBeInTheDocument()
  })
})
