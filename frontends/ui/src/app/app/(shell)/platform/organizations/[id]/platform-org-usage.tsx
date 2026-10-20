'use client'

/**
 * One organization's spend for the platform operator, drawn with the office's
 * own Budgets components (`features/budgets/components/usage-overview.tsx`), so
 * an operator on a call with an office sees what the office sees: the same
 * meters against the same limits, the same 30-day trend and the same model mix,
 * in the office's unit. Below them, the member table without its limit
 * editors; the allowance is changed from the overview's budget dialog.
 */

import { type FC, useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { Item, ItemList } from '@/components/ui/item'
import { PageHeader } from '@/components/ui/page-header'
import { Separator } from '@/components/ui/separator'
import { TooltipProvider } from '@/components/ui/tooltip'
import { SectionCard } from '@/features/platform/components/section-card'
import {
  Stat,
  UsageOverviewView,
  useSpendFormat,
  type UsageResponse,
} from '@/features/budgets/components/usage-overview'
import { useTranslations } from '@/i18n'
import { fetchPlatformOrgUsage } from '@/lib/budgets/platform-client'
import type { PlatformOrgUsage } from '@/lib/budgets/platform-contract'

export const PlatformOrgUsageView: FC<{ organizationId: string }> = ({ organizationId }) => {
  const t = useTranslations('platform')
  const [data, setData] = useState<PlatformOrgUsage | null>(null)
  const [failed, setFailed] = useState(false)

  const load = useCallback(async () => {
    setFailed(false)
    try {
      setData(await fetchPlatformOrgUsage(organizationId))
    } catch {
      setFailed(true)
    }
  }, [organizationId])

  useEffect(() => {
    void load()
  }, [load])

  const name = data?.organization.name ?? organizationId

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Button asChild variant="link" size="sm" className="text-muted-foreground h-auto p-0">
          <Link href="/app/platform">
            <ArrowLeft className="size-3.5" aria-hidden />
            {t('orgUsage.back')}
          </Link>
        </Button>
      </div>
      <PageHeader title={data ? name : t('orgUsage.title')} subtitle={t('orgUsage.subtitle')} />
      <SectionCard
        title={t('orgUsage.cardTitle')}
        description={t('orgUsage.cardDescription')}
        loading={!data && !failed}
        error={failed}
        errorMessage={t('orgUsage.loadError')}
        onRetry={() => void load()}
        skeletonRows={4}
        testId="platform-org-usage"
      >
        {data ? <OrgUsageBody data={data} /> : null}
      </SectionCard>
    </div>
  )
}

const OrgUsageBody: FC<{ data: PlatformOrgUsage }> = ({ data }) => {
  const usage: UsageResponse = data.usage
  return (
    <TooltipProvider delayDuration={100}>
      {/* `grid-spend-viz` scopes the validated chart tokens (end of globals.css). */}
      <div className="grid-spend-viz flex flex-col gap-5">
        <UsageOverviewView usage={usage} />
        <Separator />
        <MemberSpendList usage={usage} members={data.members} />
      </div>
    </TooltipProvider>
  )
}

const MemberSpendList: FC<{ usage: UsageResponse; members: PlatformOrgUsage['members'] }> = ({
  usage,
  members,
}) => {
  const t = useTranslations('platform')
  const tOrg = useTranslations('organization')
  const { formatBare } = useSpendFormat(usage.unit)
  const byId = useMemo(() => new Map(members.map((member) => [member.id, member])), [members])
  const rows = useMemo(
    () => [...(usage.perMember ?? [])].sort((a, b) => b.month.amount - a.month.amount),
    [usage]
  )

  return (
    <div>
      <p className="text-sm font-medium">{t('orgUsage.membersTitle')}</p>
      <p className="text-muted-foreground mt-0.5 text-xs">{t('orgUsage.membersDescription')}</p>
      {rows.length === 0 ? (
        <EmptyState variant="bare" title={t('orgUsage.membersEmpty')} />
      ) : (
        <ItemList as="ul" className="mt-3" data-testid="platform-org-members">
          {rows.map((spend) => {
            const member = byId.get(spend.userId)
            return (
              <Item as="li" key={spend.userId} className="flex-wrap gap-x-4 gap-y-2 px-3 py-2.5 sm:flex-nowrap">
                <div className="min-w-0 flex-1 basis-full sm:basis-0">
                  <p className="truncate text-sm">
                    {member ? (member.name ?? member.email) : t('orgUsage.memberUnknown')}
                  </p>
                  <p className="text-muted-foreground truncate text-xs">
                    {member ? (member.name ? member.email : null) : spend.userId}
                  </p>
                </div>
                <div className="flex flex-1 items-center justify-between gap-4 sm:flex-none sm:justify-end">
                  <Stat label={tOrg('budgets.today')}>{formatBare(spend.day.amount)}</Stat>
                  <Stat label={tOrg('budgets.thisMonth')}>{formatBare(spend.month.amount)}</Stat>
                </div>
              </Item>
            )
          })}
        </ItemList>
      )}
    </div>
  )
}
