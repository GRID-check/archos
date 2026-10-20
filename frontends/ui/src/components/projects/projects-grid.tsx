'use client'

/**
 * Projects-home client island: the header row (page title, client-side name
 * filter, "New project" action), the resume rail, the projects list, and every
 * empty state. The index page stays server-rendered (DB reads, authz, the Archiv
 * entry card, recently-deleted); this component owns only the search state
 * and the `?new=1` auto-open wiring for the create dialog.
 *
 * Shape of the page, and why it is not one uniform card grid any more: the first
 * three projects are the ones this person actually works in, as the usual
 * `ProjectCard`s, and everything else is a dense `ProjectListRow` list. Both are
 * built from the same atoms (`project-atoms.tsx`) — the rail is a selection and
 * an ordering, not a new kind of card. A grid where every project is equally loud reads fine at
 * six and becomes a wall at forty — and the old ordering put the project someone
 * touched ten minutes ago below three they have never opened. The rail is a
 * fixed size regardless of how many projects exist, so the page's shape stops
 * changing once the list starts growing.
 *
 * Searching collapses both sections into one flat result list: with a query on
 * screen, "continue where you left off" is not the question being asked.
 */

import type { JSX } from 'react'
import { useMemo, useState } from 'react'
import { Search } from 'lucide-react'
import { RisoPrint } from '@/components/brand/riso-print'
import { Button } from '@/components/ui/button'
import { CountPill } from '@/components/ui/count-pill'
import { EmptyState } from '@/components/ui/empty-state'
import { ItemList } from '@/components/ui/item'
import { SearchField } from '@/components/ui/search-field'
import { SectionLabel } from '@/components/ui/section-label'
import { projectMatchesQuery } from '@/features/projects/lib/project-search'
import { splitForResume } from '@/features/projects/lib/resume-selection'
import {
  countByStatus,
  defaultProjectStatusFilter,
  filterProjectsByStatus,
  isProjectStatusFilter,
  PROJECT_STATUS_FILTERS,
  type ProjectStatusFilter,
} from '@/features/projects/lib/status-filter'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import type { Project } from '@/lib/db/schema'
import { useTranslations } from '@/i18n'
import { TOUR_ANCHORS } from '@/features/onboarding/lib/product-tour'
import { CreateProjectDialog } from './create-project-dialog'
import { ProjectCard } from './project-card'
import { ProjectListRow } from './project-list-row'

interface ProjectsGridProps {
  projects: Project[]
  /** Ingested document count per project id. */
  docCounts: Record<string, number>
  /** ISO timestamp of the VIEWER's own last activity, keyed by project id. */
  viewerActivity?: Record<string, string>
  /** Open the create dialog on mount — wired to `/app/projects?new=1`. */
  autoOpenCreate?: boolean
}

/**
 * Section eyebrow with an optional count beside it.
 *
 * Both pieces come from the primitives — `SectionLabel` for the ~10.5px
 * uppercase eyebrow, `CountPill` for the quiet number next to a heading. This
 * wrapper is only the arrangement of the two. It briefly hand-rolled both, at
 * nearly double the documented tracking and with the count dimmed to
 * `text-muted-foreground/70` — about 2.2:1 on paper, which is not a hierarchy
 * signal, it is an unreadable number. The pill's fill does that job at full
 * contrast instead.
 */
function SectionHeading({ id, children, count }: { id: string; children: string; count?: number }): JSX.Element {
  return (
    <div className="mb-3 flex items-center gap-2.5">
      <SectionLabel as="h2" id={id}>
        {children}
      </SectionLabel>
      {count !== undefined && <CountPill>{count}</CountPill>}
    </div>
  )
}

/** Only work in progress takes a rail slot; a paused or closed project keeps its place in the list (ADR-0098). */
const isRailable = (project: Project): boolean => project.status === 'active'

export function ProjectsGrid({
  projects,
  docCounts,
  viewerActivity = {},
  autoOpenCreate = false,
}: ProjectsGridProps): JSX.Element {
  const t = useTranslations('projects')
  const [query, setQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<ProjectStatusFilter>(() => defaultProjectStatusFilter(projects))
  const statusCounts = useMemo(() => countByStatus(projects), [projects])
  // Offered only once there is something to tell apart: a list of active
  // projects alone needs no control that would only ever show one answer. A
  // segment with nothing in it is left out, except Aktiv and Alle.
  const showStatusFilter = statusCounts.closed > 0 || statusCounts.paused > 0
  const statusOptions = PROJECT_STATUS_FILTERS.filter(
    (option) => option === 'active' || option === 'all' || statusCounts[option] > 0
  )
  // A segment that emptied (its last project moved) is gone, so it is no longer
  // what the list shows either.
  const activeFilter: ProjectStatusFilter = statusOptions.includes(statusFilter) ? statusFilter : 'all'

  const needle = query.trim().toLowerCase()
  const isSearching = needle.length > 0

  const filtered = useMemo(() => {
    const inStatus = showStatusFilter ? filterProjectsByStatus(projects, activeFilter) : projects
    if (!needle) return inStatus
    return inStatus.filter((project) => projectMatchesQuery(project, needle))
  }, [projects, needle, activeFilter, showStatusFilter])
  const emptyInStatus = showStatusFilter && !isSearching && filtered.length === 0

  // One helper serves both modes: zero rail slots turns the split into "order
  // everything by recency", which is exactly what a result list wants too.
  const { resume, rest, basis } = useMemo(
    () => splitForResume(filtered, viewerActivity, isSearching ? 0 : undefined, isRailable),
    [filtered, viewerActivity, isSearching],
  )

  const hasProjects = projects.length > 0

  const renderRow = (project: Project): JSX.Element => (
    <ProjectListRow
      key={project.id}
      project={project}
      docCount={docCounts[project.id] ?? 0}
      activityAt={viewerActivity[project.id]}
    />
  )

  return (
    <div>
      {/* Title and the one primary action share the first line at every width;
          the search takes its own line below on a phone and sits left of the
          action from `sm`. The page header primitive cannot say that (it stacks
          title over action below `sm`, which is what clipped „Neues Projekt“
          beside a full-width field), so this is a grid of three: title, search,
          action, placed per breakpoint. The h1 is the ramp's page title. */}
      <header className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-4 sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:gap-x-2.5">
        <h1 className="min-w-0 text-balance text-xl font-semibold tracking-tight">{t('list.heading')}</h1>
        {hasProjects && (
          // The one search molecule: magnifier + input with the phone keyboard
          // already told what Enter does. It matches name, address, Gemeinde and
          // client (`projectMatchesQuery`), which is what an architect on site
          // remembers a project by. The reset control is for a thumb that has
          // just typed a wrong word; 44px on touch.
          <SearchField
            value={query}
            onChange={setQuery}
            placeholder={t('list.searchPlaceholder')}
            label={t('list.searchAria')}
            clearLabel={t('list.searchReset')}
            inputClassName="pointer-coarse:pr-11"
            className="col-span-2 row-start-2 sm:col-span-1 sm:col-start-2 sm:row-start-1 sm:w-64"
          />
        )}
        {/* Primary near-black action — Button default variant consumes --primary.
            With no project yet the empty state below carries the one action:
            two buttons for the same thing read as two different things. */}
        {hasProjects && (
          <div className="col-start-2 row-start-1 sm:col-start-3">
            <CreateProjectDialog defaultOpen={autoOpenCreate} tourAnchor={TOUR_ANCHORS.createProject} />
          </div>
        )}
      </header>

      {showStatusFilter && (
        <ToggleGroup
          type="single"
          value={activeFilter}
          onValueChange={(value) => {
            if (isProjectStatusFilter(value)) setStatusFilter(value)
          }}
          segmented
          size="sm"
          aria-label={t('list.filter.label')}
          className="mt-5"
          data-testid="project-status-filter"
        >
          {statusOptions.map((option) => (
            <ToggleGroupItem key={option} value={option} data-testid={`project-status-filter-${option}`}>
              {t(`list.filter.${option}`)}
              <CountPill>{statusCounts[option]}</CountPill>
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      )}

      <div className="mt-7">
        {!hasProjects ? (
          <EmptyState
            art={<RisoPrint id="vignetten/abstecken/empty" />}
            title={t('list.empty.title')}
            description={t('list.empty.description')}
            action={
              <CreateProjectDialog
                label={t('list.empty.action')}
                defaultOpen={autoOpenCreate}
                tourAnchor={TOUR_ANCHORS.createProject}
              />
            }
            className="min-h-96 justify-center"
          />
        ) : emptyInStatus ? (
          <EmptyState
            variant="bare"
            title={t(`list.noneInFilter.${activeFilter === 'all' ? 'active' : activeFilter}`)}
            description={t('list.noneInFilter.description')}
            action={
              <Button variant="outline" size="sm" onClick={() => setStatusFilter('all')}>
                {t('list.noneInFilter.showAll')}
              </Button>
            }
          />
        ) : isSearching ? (
          rest.length === 0 ? (
            <EmptyState
              variant="bare"
              icon={Search}
              title={t('list.noMatch.title')}
              description={t('list.noMatch.description')}
              action={
                <Button variant="outline" size="sm" onClick={() => setQuery('')}>
                  {t('list.noMatch.clear')}
                </Button>
              }
            />
          ) : (
            <section aria-labelledby="projects-results" className="animate-in fade-in-0 duration-base ease-out motion-reduce:animate-none">
              <SectionHeading id="projects-results" count={rest.length}>
                {t('list.results.heading')}
              </SectionHeading>
              {/* One connected list: `ItemList` rounds only the outer corners and
                  draws the hairlines between rows. `-mx-3` puts the row content on
                  the heading's left edge. */}
              <ItemList as="ul" className="-mx-3 bg-card">
                {rest.map(renderRow)}
              </ItemList>
            </section>
          )
        ) : (
          // `gap-8` is the documented gap between major sections; whitespace
          // does the separating, so neither heading needs a rule under it.
          <div className="flex flex-col gap-8 animate-in fade-in-0 duration-base ease-out motion-reduce:animate-none">
            {resume.length > 0 && (
              <section aria-labelledby="projects-resume">
                <SectionHeading id="projects-resume">
                  {basis === 'activity' ? t('list.resume.heading') : t('list.resume.fallbackHeading')}
                </SectionHeading>
                {/* The staple project card, unchanged — the rail is a selection
                    and an ordering, not a new kind of card. */}
                {/* On a phone the rail is ONE row you swipe, not three cards
                    stacked: stacked, they pushed the list below the first
                    screen, and on site the question is "which of my two or three
                    projects" and then "everything else". The next card peeks
                    (84%) so the row says it scrolls. From `sm` on a tall screen it
                    is the grid it always was; a phone on its side (852 x 393)
                    keeps the row, because three cards stacked in two columns
                    fill its whole height. The vertical padding is the room the card's
                    shadow and lift need inside a scroll container, which clips
                    on both axes. */}
                <div
                  data-testid="projects-resume-rail"
                  className="scrollbar-hide -mx-4 -my-2 flex snap-x snap-mandatory scroll-px-4 gap-3 overflow-x-auto px-4 py-2 sm:[@media(min-height:32rem)]:m-0 sm:[@media(min-height:32rem)]:grid sm:[@media(min-height:32rem)]:grid-cols-2 sm:[@media(min-height:32rem)]:gap-6 sm:[@media(min-height:32rem)]:overflow-visible sm:[@media(min-height:32rem)]:p-0 lg:[@media(min-height:32rem)]:grid-cols-3"
                >
                  {resume.map((project) => (
                    <div
                      key={project.id}
                      className="w-[84%] shrink-0 snap-start max-sm:only:w-full sm:w-72 sm:[@media(min-height:32rem)]:w-auto"
                    >
                      <ProjectCard
                        project={project}
                        docCount={docCounts[project.id] ?? 0}
                        activityAt={viewerActivity[project.id]}
                      />
                    </div>
                  ))}
                </div>
              </section>
            )}

            {rest.length > 0 && (
              <section aria-labelledby="projects-more">
                {/* "More projects", not "All projects": this list is everything
                    MINUS the rail, so an "all" heading would sit above a count
                    that disagrees with the page. */}
                <SectionHeading id="projects-more" count={rest.length}>
                  {resume.length > 0 ? t('list.more.heading') : t(`list.filter.${activeFilter}`)}
                </SectionHeading>
                <ItemList as="ul" className="-mx-3 bg-card">
                  {rest.map(renderRow)}
                </ItemList>
              </section>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
