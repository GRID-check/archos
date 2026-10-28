/**
 * Platform → Feedback. The reports members send from inside Piloti (bugs,
 * ideas, praise, questions), across every organization, with their triage
 * status. A `feedback.submitted` inbox row lands here with `?report=<id>`;
 * the Slack alert's „Übernehmen" button with `?claim=<ticket id>`, which
 * assigns that ticket to the reader in PostHog.
 *
 * Owner gate, shell chrome and section nav live in the shared `layout.tsx`;
 * this page names its section and decides whether the reader may triage.
 */

import type { JSX } from 'react'
import { PageHeader } from '@/components/ui/page-header'
import { withPageSession } from '@/lib/auth/require-auth'
import { PLATFORM_PERMISSIONS } from '@/lib/authz/permissions'
import { hasPlatformPermission } from '@/lib/authz/platform'
import { getTranslations } from '@/i18n/server'
import { platformCopy } from '@/i18n/namespaces/platform'
import { FeedbackTriage } from '@/features/product-feedback/components/feedback-triage'

export default async function PlatformFeedbackPage({
  searchParams,
}: {
  searchParams: Promise<{ report?: string | string[]; claim?: string | string[] }>
}): Promise<JSX.Element> {
  const t = await getTranslations(platformCopy)
  const { report, claim } = await searchParams
  const canTriage = await withPageSession((session) =>
    hasPlatformPermission(session, PLATFORM_PERMISSIONS.settingsManage)
  )
  const focusReportId = typeof report === 'string' ? report : null
  const claimTicketId = typeof claim === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(claim) ? claim : null

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t('sections.feedback.title')} subtitle={t('sections.feedback.subtitle')} />
      <FeedbackTriage canTriage={canTriage} focusReportId={focusReportId} claimTicketId={claimTicketId} />
    </div>
  )
}
