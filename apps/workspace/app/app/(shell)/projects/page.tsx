import type { JSX } from 'react'
import { withPageSession } from '@/lib/auth/require-auth'
import { getNavFlags } from '@/lib/authz/nav'
import { canManageCompliance } from '@/lib/authz/organizations'
import { getProjectsGridData } from '@/lib/projects/service'
import { ProjectsGrid } from '@/components/projects/projects-grid'
import { OfficeShelfEntryCard } from '@/components/projects/office-shelf-entry-card'
import { ShellContent } from '@/components/shell'
import { RecentlyDeleted } from '@/features/projects/components/recently-deleted'
import { getTranslations } from '@/i18n/server'
import { projectsCopy } from '@/i18n/namespaces/projects'

interface ProjectsPageProps {
  searchParams: Promise<{ new?: string }>
}

export default async function ProjectsPage({
  searchParams,
}: ProjectsPageProps): Promise<JSX.Element> {
  return withPageSession(async (session) => {
    const navFlags = await getNavFlags(session)
    const { new: newParam } = await searchParams
    const t = await getTranslations(projectsCopy)

    // The page is transport: it resolves the session, asks the service for the
    // view, and renders. Tenancy scope, FGA filtering and the document counts all
    // belong to the service/repository pair behind this call — see
    // `getProjectsGridData`.
    // 'newest' rather than 'oldest': the grid orders itself by recency now (the
    // resume rail, then the list), and the repository's order decides which
    // projects survive PROJECT_LIST_LIMIT — at the cap, dropping the oldest is
    // the right direction to lose them in.
    const {
      projects: rows,
      documentCounts: docCountByProject,
      viewerActivity,
    } = await getProjectsGridData(session, 'newest')

    const autoOpenCreate = newParam === '1'

    return (
      // `wide`: this page is a card grid, which is what that opt-in is for. The
      // frame owns the `<main>`, the scroll container and the page background —
      // this is only the column.
      <ShellContent width="wide">
        <ProjectsGrid
          projects={rows}
          docCounts={docCountByProject}
          viewerActivity={viewerActivity}
          autoOpenCreate={autoOpenCreate}
        />

        {/* Org-wide Archiv entry — every member of an organization reaches it
            (`canAccessOfficeShelf`, ADR-0024). */}
        {navFlags.canAccessOfficeShelf && (
          <section className="mt-6" aria-label={t('officeShelfCard.title')}>
            <OfficeShelfEntryCard />
          </section>
        )}

        <RecentlyDeleted canManageCompliance={canManageCompliance(session)} />
      </ShellContent>
    )
  })
}
