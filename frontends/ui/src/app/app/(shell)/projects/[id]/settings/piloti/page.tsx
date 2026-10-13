import type { JSX } from 'react'
import { type Metadata } from 'next'
import { withPageSession } from '@/lib/auth/require-auth'
import { requireProjectAccess } from '@/lib/authz/projects'
import { SettingsSectionIntro } from '@/features/projects/components/settings/settings-panel'
import { PilotiActivity } from '@/features/piloti-activity/components/piloti-activity'
import { getTranslations } from '@/i18n/server'

interface PageProps {
  params: Promise<{ id: string }>
}

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('settings')
  return { title: t('project.nav.piloti') }
}

/**
 * Settings → Was Piloti tut: what Piloti is doing in this project, for every
 * member. The page gates on `project:view`, like Memory; what the reader may
 * see of each row is the API's decision (`docs/architecture/piloti-activity.md`).
 */
export default async function ProjectPilotiActivityPage({
  params,
}: PageProps): Promise<JSX.Element> {
  return withPageSession(async (session) => {
    const { id } = await params
    await requireProjectAccess(session, id, 'project:view')
    const t = await getTranslations('settings')

    return (
      <div className="flex flex-col gap-6">
        <SettingsSectionIntro
          title={t('project.pilotiActivity.title')}
          description={t('project.pilotiActivity.intro')}
        />
        <PilotiActivity projectId={id} />
      </div>
    )
  })
}
