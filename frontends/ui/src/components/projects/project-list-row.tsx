'use client'

/**
 * One row of the projects list — everything below the resume rail on
 * projects-home.
 *
 * A different ARRANGEMENT of the project card, not a different component: every
 * part here comes from `project-atoms.tsx`, the same atoms `ProjectCard` is
 * assembled from, so the name, the brief, the timestamp rule and the settings
 * gear behave identically in both. Only the layout differs — card material
 * spread into a row, with the meta moved into right-aligned tabular columns.
 * See `docs/design/project-surfaces.md`.
 *
 * The rows are one CONNECTED list, not a stack of pills: the row is an `Item`
 * (the list-row atom) and the `ItemList` that holds the rows (projects-grid)
 * clips the outer corners and draws the hairlines between them. So only the
 * first and last row are rounded, and a row carries no radius, border or shadow
 * of its own. See `docs/design/grid-design-language.md#component-layers-atomic-design`.
 *
 * Why a row at all: past a dozen projects a card grid stops being a set of
 * objects and becomes a wall — nothing is ranked, every tile costs the same
 * attention, and finding a name means reading all of them. The row spends the
 * density it wins on the two things a scan needs: a fixed left edge to index by
 * (the initials tile) and columns that line up down the page.
 *
 * The row carries the status chip only for a project that is not active
 * (ADR-0098): Ruhend, Abgeschlossen, Nicht realisiert. An „Aktiv" chip on every
 * row would be a solid band of chroma reading as the loudest thing on the page
 * while carrying no information; the exception is the one worth reading.
 */

import type { JSX } from 'react'
import { Item } from '@/components/ui/item'
import type { Project } from '@/lib/db/schema'
import { ProjectStatusMark } from './project-status'
import {
  ProjectActivity,
  ProjectDocCount,
  ProjectInitialsTile,
  ProjectOpenLink,
  ProjectSettingsLink,
  ProjectSummaryLine,
} from './project-atoms'

interface ProjectListRowProps {
  project: Project
  /** Number of documents ingested into the project corpus. */
  docCount?: number
  /** ISO timestamp of the VIEWER's own last activity, when they have any. */
  activityAt?: string
}

export function ProjectListRow({ project, docCount = 0, activityAt }: ProjectListRowProps): JSX.Element {
  return (
    // `Item` is the row. Its hover tint is the feedback; there is no lift, because
    // a lifted row would detach from the rows either side of it. The stretched
    // link's ring is square (`after:rounded-none`) so it follows the row, not a
    // pill that no longer exists.
    <Item as="li" className="group relative gap-3 px-3 py-2.5 has-[a:focus-visible]:bg-accent/40">
      {/* Hidden on phones: indexing a single narrow column by initials is worth
          less than the 48px it takes from names that are already truncating. */}
      <ProjectInitialsTile project={project} className="hidden sm:grid" />

      <div className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-2 text-sm font-medium">
          <span className="truncate">
            <ProjectOpenLink project={project} className="after:rounded-none" />
          </span>
          <ProjectStatusMark project={project} />
        </span>
        <ProjectSummaryLine project={project} fallback={false} className="mt-0.5" />
      </div>

      {/* Left-aligned inside its fixed column: right-aligning an icon+text pair
          whose text width varies ("1 document" … "24 documents") staggers the
          ICON, which is the thing the eye actually indexes the column by. The
          ragged edge falls on the word instead, where nobody is scanning. */}
      <ProjectDocCount count={docCount} className="hidden w-[104px] shrink-0 lg:flex" />

      {/* The one meta column that survives to the narrowest screen: with the
          brief truncated and the tile gone, "when was I last in this" is what is
          left to choose a row by. */}
      <ProjectActivity
        project={project}
        activityAt={activityAt}
        showLabel={false}
        className="w-[72px] shrink-0 text-right sm:w-[104px]"
      />

      <ProjectSettingsLink project={project} className="shrink-0" />
    </Item>
  )
}
