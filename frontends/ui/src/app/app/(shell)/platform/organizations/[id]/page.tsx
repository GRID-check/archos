/**
 * Platform → one organization's spend: the Budgets view the office itself
 * sees, read-only, opened from the organization directory on the overview.
 *
 * Owner gate, shell chrome and section nav live in the shared `layout.tsx`;
 * the API checks `platform:usage:view` on every read.
 */

import type { JSX } from 'react'
import { PlatformOrgUsageView } from './platform-org-usage'

interface PageProps {
  params: Promise<{ id: string }>
}

export default async function PlatformOrganizationPage({ params }: PageProps): Promise<JSX.Element> {
  const { id } = await params
  return <PlatformOrgUsageView organizationId={id} />
}
