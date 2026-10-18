import type { JSX } from 'react'
import { type Metadata } from 'next'
import { notFound } from 'next/navigation'
import { withPageSession } from '@/lib/auth/require-auth'
import { requireProjectAccess } from '@/lib/authz/projects'
import { listProjectAnnotations } from '@/lib/annotations/project-marks'
import { PROJECT_MARKS_PAGE_SIZE } from '@/lib/annotations/project-types'
import { findProjectInOrg } from '@/lib/projects/repository'
import { getTranslations } from '@/i18n/server'
import { OpenPointsPanel } from '@/features/documents/components/open-points/open-points-panel'

interface OpenPointsPageProps {
  params: Promise<{ id: string }>
}

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('files')
  return { title: t('openPoints.title') }
}

/**
 * A project's Offene Punkte: the open Anmerkungen of all its documents, for
 * the Jour fixe. The first page is read here, with the page's default filters,
 * so the first paint is the list; the panel reads every other page and filter
 * through the typed client.
 */
export default async function OpenPointsPage({ params }: OpenPointsPageProps): Promise<JSX.Element> {
  return withPageSession(async (session) => {
    const { id } = await params
    await requireProjectAccess(session, id, 'project:view')
    if (!(await findProjectInOrg(id, session.organizationId))) notFound()
    const initial = await listProjectAnnotations(session, id, {
      status: 'open',
      order: 'document',
      limit: PROJECT_MARKS_PAGE_SIZE,
    }).catch((error: unknown) => {
      console.error('[open-points] the open points could not be read:', error)
      return null
    })
    return <OpenPointsPanel projectId={id} currentUserId={session.userId} initial={initial} />
  })
}
