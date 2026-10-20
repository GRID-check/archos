'use client'

/**
 * Usage & budgets (ADR-0015, ADR-0053) — what the organization is spending on
 * LLM calls, in ITS unit, and how close that spend is to the limits that will
 * stop it. The unit comes from the usage endpoint: credits for an organization
 * the platform bills, tokens for one on its own key, which sees no credits and
 * no price at all. The platform's purchase price never reaches this card,
 * because the endpoint never sends it.
 *
 * **Three questions, three forms — chosen before any color was picked.**
 *
 * 1. *Am I about to be cut off?* is a single ratio against a limit, and the
 *    form for a ratio against a limit is a **meter**, not a chart. Two of them
 *    (today, this month) because the two limits are enforced separately and a
 *    reader who is fine on the month can still be blocked by the day.
 * 2. *Where is the money going?* is **part-to-whole** across models, which is a
 *    horizontal stacked bar plus its table twin.
 * 3. *Is this getting worse?* is **change over time**, which is the 30-day
 *    column chart (`SpendTrendChart`) — admins only, because only they are
 *    served the series.
 *
 * **The meter is no longer painted by model, and that is the point.** It used
 * to be a single stacked bar doing both job 1 and job 2 at once: eight
 * categorical hues on a bar whose whole story is one number. Two things broke.
 * The reader could not tell a healthy meter from an exhausted one, because the
 * fill color was carrying model identity and had nothing left to say about
 * state; and the segment for the model that mattered was, at 4% of a 300px
 * bar, twelve pixels of hue with no room for a label. Splitting them lets the
 * meter fill carry *severity* — accent under the limit, the critical status
 * step at or over it — and gives composition its own full-width bar where a
 * small share is still a visible slice.
 *
 * **No number is reachable only by hovering.** The per-model table under the
 * composition bar is always open, not behind a toggle. It is doing three jobs
 * at once: it is the legend (every model named beside its swatch, so identity
 * is never color-alone), it is the table view the method requires, and it is
 * the mandatory relief for the light-mode contrast WARN — three of the eight
 * light slots sit below 3:1 on white, which is legal only when the values are
 * also readable as text. Segments carry hover/focus tooltips on top of that,
 * never instead of it.
 *
 * **No labels inside the segments.** Every segment of a stacked bar except the
 * outermost is an interior segment with no free end to spill into, and a label
 * that does not fit gets clipped rather than shortened. The method's answer is
 * to skip the inline label and let the legend and the table carry it, which is
 * what the table below is for.
 *
 * **Color follows the model, never its rank.** Slots are assigned by sorting
 * model ids alphabetically, so a model keeps its hue when the reader moves
 * between the day and the month numbers and when a new model starts appearing.
 * Letting rank drive the palette would repaint every survivor the moment the
 * set changed. Past the eight documented slots the tail folds into a neutral
 * "Other" — a ninth generated hue is indistinguishable from an existing one
 * under CVD.
 *
 * **The bar stacks in palette order; the table lists in spend order.** These
 * differ on purpose. The palette's colorblind separation is only validated for
 * *adjacent* slots — the pairs that actually touch in a stack — so stacking by
 * size would put arbitrary, unvalidated pairs against each other. Table rows do
 * not touch, so there the useful order is the one that answers "who is biggest".
 * (Filtering out models that spent nothing can still skip a slot and put 2
 * beside 4; the 2px surface gap and the named table rows are what carry that
 * case, which is exactly the secondary encoding the method asks for.)
 *
 * **CSS-box marks, not SVG.** Every mark here is one-dimensional — a fill along
 * a horizontal track. A box gets an exact 4px radius on the data end and an
 * exact 2px surface gap between segments at any container width; the same
 * shapes in a `viewBox` need either measured pixel widths or a non-uniform
 * scale that would smear the corner radii. The 30-day trend, which does have a
 * second dimension, is its own component.
 *
 * The palette itself is not chosen here — it is the token block at the end of
 * `globals.css`, validated for both modes against this app's real card
 * surfaces. See that block for the validator output and the contrast relief
 * rule it obliges.
 *
 * Mobile-first: rows/forms stack under the `sm` breakpoint, stats carry their
 * own micro-labels (no table header to lose), and controls go full-width.
 */

import { type FC, useCallback, useEffect, useMemo, useState } from 'react'
import { Pencil } from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Field, FieldError, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Item, ItemList } from '@/components/ui/item'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Separator } from '@/components/ui/separator'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { useLocale, useTranslations } from '@/i18n'
import { LimitEditor, readLimit, type PolicyDto } from '@/features/budgets/components/limit-editor'
import {
  Stat,
  UsageOverviewView,
  UsageSkeleton,
  useSpendFormat,
  type UsageResponse,
} from '@/features/budgets/components/usage-overview'

interface MemberDto {
  id: string
  email: string
  name: string | null
}

interface ProjectDto {
  id: string
  name: string
}

const policyLimitLabel = (
  policy: PolicyDto,
  perDay: string,
  perMonth: string,
  formatAmount: (value: number) => string
): string => {
  const parts: string[] = []
  if (policy.dailyLimit !== null)
    parts.push(`${formatAmount(Number.parseFloat(policy.dailyLimit))}/${perDay}`)
  if (policy.monthlyLimit !== null)
    parts.push(`${formatAmount(Number.parseFloat(policy.monthlyLimit))}/${perMonth}`)
  return parts.join(' · ') || '—'
}

export const BudgetUsageCard: FC<{ isAdmin: boolean }> = ({ isAdmin }) => {
  const t = useTranslations('organization')
  const { locale } = useLocale()
  const [usage, setUsage] = useState<UsageResponse | null>(null)
  const [policies, setPolicies] = useState<PolicyDto[]>([])
  const [members, setMembers] = useState<MemberDto[]>([])
  const [projects, setProjects] = useState<ProjectDto[]>([])
  const [loading, setLoading] = useState(true)

  const [dailyLimit, setDailyLimit] = useState('')
  const [monthlyLimit, setMonthlyLimit] = useState('')
  const [savingLimits, setSavingLimits] = useState(false)
  const [selectedProject, setSelectedProject] = useState('')

  const load = useCallback(async () => {
    try {
      const [usageRes, budgetsRes] = await Promise.all([
        fetch('/api/organization/usage'),
        fetch('/api/organization/budgets'),
      ])
      if (!usageRes.ok || !budgetsRes.ok) throw new Error('load failed')
      const usageBody = (await usageRes.json()) as UsageResponse
      const budgetsBody = (await budgetsRes.json()) as {
        organization: { dailyLimit: number | null; monthlyLimit: number | null }
        policies?: PolicyDto[]
      }
      setUsage(usageBody)
      setPolicies((budgetsBody.policies ?? []).filter((policy) => policy.scope !== 'organization'))
      setDailyLimit(budgetsBody.organization.dailyLimit?.toString() ?? '')
      setMonthlyLimit(budgetsBody.organization.monthlyLimit?.toString() ?? '')
    } catch {
      toast.error(t('budgets.loadError'))
    } finally {
      setLoading(false)
    }
  }, [t])

  useEffect(() => {
    void load()
  }, [load])

  // Pickers (admin only): the member directory and org projects, best-effort.
  useEffect(() => {
    if (!isAdmin) return
    fetch('/api/organization/members')
      .then(async (res) => (res.ok ? ((await res.json()) as { members: MemberDto[] }).members : []))
      .then(setMembers)
      .catch(() => setMembers([]))
    fetch('/api/projects')
      .then(async (res) => (res.ok ? ((await res.json()) as ProjectDto[]) : []))
      .then((rows) => setProjects(rows.map((row) => ({ id: row.id, name: row.name }))))
      .catch(() => setProjects([]))
  }, [isAdmin])

  /** Directory ∪ ledger: members with spend sorted first, then the rest. */
  const memberRows = useMemo(() => {
    const spendByUser = new Map((usage?.perMember ?? []).map((entry) => [entry.userId, entry]))
    const known = new Set(members.map((member) => member.id))
    const rows = members.map((member) => ({ member, spend: spendByUser.get(member.id) ?? null }))
    for (const entry of usage?.perMember ?? []) {
      if (!known.has(entry.userId)) {
        rows.push({ member: { id: entry.userId, email: entry.userId, name: null }, spend: entry })
      }
    }
    return rows.sort((a, b) => (b.spend?.month.amount ?? 0) - (a.spend?.month.amount ?? 0))
  }, [members, usage])

  const memberPolicies = useMemo(
    () => new Map(policies.filter((p) => p.scope === 'member').map((p) => [p.subjectId, p])),
    [policies]
  )
  const projectPolicies = useMemo(() => policies.filter((p) => p.scope === 'project'), [policies])

  const orgDailyInput = readLimit(dailyLimit, locale)
  const orgMonthlyInput = readLimit(monthlyLimit, locale)

  const saveOrgLimits = useCallback(async () => {
    const daily = readLimit(dailyLimit, locale)
    const monthly = readLimit(monthlyLimit, locale)
    if (!daily.ok || !monthly.ok) return
    setSavingLimits(true)
    try {
      const res = await fetch('/api/organization/budgets', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scope: 'organization',
          dailyLimit: daily.value,
          monthlyLimit: monthly.value,
        }),
      })
      if (res.status === 422) {
        const body = (await res.json()) as { error?: string }
        toast.error(body.error ?? t('budgets.limitsSaveError'))
        return
      }
      if (!res.ok) throw new Error(String(res.status))
      toast.success(t('budgets.limitsSaved'))
      await load()
    } catch {
      toast.error(t('budgets.limitsSaveError'))
    } finally {
      setSavingLimits(false)
    }
  }, [dailyLimit, monthlyLimit, locale, t, load])

  // Before the early return: a hook must run on every render.
  const { onOwnKey, formatBare, requestsLabel, unitWord } = useSpendFormat(usage?.unit ?? 'credit')

  if (loading || !usage) {
    return <UsageSkeleton />
  }

  const projectName = (id: string | null): string =>
    projects.find((p) => p.id === id)?.name ?? id ?? `(${t('budgets.subjectGone')})`

  return (
    <TooltipProvider delayDuration={100}>
      {/* `grid-spend-viz` scopes the validated chart tokens (end of globals.css). */}
      <div className="grid-spend-viz animate-in fade-in-0 duration-base flex min-h-[16rem] flex-col gap-5 ease-out motion-reduce:animate-none">
        <UsageOverviewView usage={usage} />

        {isAdmin && (
          <>
            <Separator />
            {/* Organization limits */}
            <div>
              <p className="text-sm font-medium">{t('budgets.limitsTitle')}</p>
              <p className="text-muted-foreground mt-0.5 text-xs">
                {t(onOwnKey ? 'budgets.limitsDescriptionTokens' : 'budgets.limitsDescription')}
              </p>
              <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-end">
                <Field className="flex-1 sm:max-w-40">
                  <FieldLabel htmlFor="budget-daily">
                    {t('budgets.dailyLimit', { unit: unitWord })}
                  </FieldLabel>
                  <Input
                    id="budget-daily"
                    inputMode="decimal"
                    value={dailyLimit}
                    onChange={(e) => setDailyLimit(e.target.value)}
                    placeholder={t('budgets.noLimitPlaceholder')}
                    aria-invalid={!orgDailyInput.ok || undefined}
                  />
                  {!orgDailyInput.ok && <FieldError>{t('budgets.limitInvalid')}</FieldError>}
                </Field>
                <Field className="flex-1 sm:max-w-40">
                  <FieldLabel htmlFor="budget-monthly">
                    {t('budgets.monthlyLimit', { unit: unitWord })}
                  </FieldLabel>
                  <Input
                    id="budget-monthly"
                    inputMode="decimal"
                    value={monthlyLimit}
                    onChange={(e) => setMonthlyLimit(e.target.value)}
                    placeholder={t('budgets.noLimitPlaceholder')}
                    aria-invalid={!orgMonthlyInput.ok || undefined}
                  />
                  {!orgMonthlyInput.ok && <FieldError>{t('budgets.limitInvalid')}</FieldError>}
                </Field>
                <Button
                  className="w-full sm:w-auto"
                  onClick={saveOrgLimits}
                  disabled={savingLimits || !orgDailyInput.ok || !orgMonthlyInput.ok}
                >
                  {t('budgets.saveLimits')}
                </Button>
              </div>
            </div>

            <Separator />
            {/* Member usage & limits table */}
            <div>
              <p className="text-sm font-medium">{t('budgets.membersTitle')}</p>
              <p className="text-muted-foreground mt-0.5 text-xs">
                {t('budgets.membersDescription')}
              </p>
              <ItemList as="ul" className="mt-3">
                {memberRows.map(({ member, spend }) => {
                  const policy = memberPolicies.get(member.id)
                  return (
                    <Item
                      as="li"
                      key={member.id}
                      className="flex-wrap gap-x-4 gap-y-2 px-3 py-2.5 sm:flex-nowrap"
                    >
                      <div className="min-w-0 flex-1 basis-full sm:basis-0">
                        <p className="truncate text-sm">{member.name ?? member.email}</p>
                        {member.name && (
                          <p className="text-muted-foreground truncate text-xs">{member.email}</p>
                        )}
                      </div>
                      <div className="flex flex-1 items-center justify-between gap-4 sm:flex-none sm:justify-end">
                        <Stat label={t('budgets.today')}>
                          {spend ? formatBare(spend.day.amount) : '—'}
                        </Stat>
                        <Stat label={t('budgets.thisMonth')}>
                          {spend ? (
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <span className="cursor-default">
                                  {formatBare(spend.month.amount)}
                                </span>
                              </TooltipTrigger>
                              <TooltipContent>{requestsLabel(spend.month.events)}</TooltipContent>
                            </Tooltip>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </Stat>
                        <Stat label={t('budgets.limitLabel')}>
                          {policy ? (
                            policyLimitLabel(
                              policy,
                              t('budgets.perDay'),
                              t('budgets.perMonth'),
                              formatBare
                            )
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </Stat>
                        <LimitEditor
                          scope="member"
                          subjectId={member.id}
                          subjectLabel={member.name ?? member.email}
                          current={policy}
                          unitWord={unitWord}
                          onSaved={load}
                          trigger={
                            <Button
                              variant="ghost"
                              size="sm"
                              title={t('budgets.setLimit')}
                              aria-label={`${t('budgets.setLimit')}: ${member.email}`}
                            >
                              <Pencil className="text-muted-foreground size-3.5" aria-hidden />
                            </Button>
                          }
                        />
                      </div>
                    </Item>
                  )
                })}
              </ItemList>
            </div>

            <Separator />
            {/* Project limits */}
            <div>
              <p className="text-sm font-medium">{t('budgets.scopedTitle')}</p>
              <p className="text-muted-foreground mt-0.5 text-xs">
                {t('budgets.scopedDescription')}
              </p>
              <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center">
                <Select value={selectedProject || undefined} onValueChange={setSelectedProject}>
                  <SelectTrigger className="w-full sm:w-72">
                    <SelectValue placeholder={t('budgets.selectProject')} />
                  </SelectTrigger>
                  <SelectContent>
                    {projects.map((project) => (
                      <SelectItem key={project.id} value={project.id}>
                        {project.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {selectedProject && (
                  <LimitEditor
                    scope="project"
                    subjectId={selectedProject}
                    subjectLabel={projectName(selectedProject)}
                    current={projectPolicies.find((p) => p.subjectId === selectedProject)}
                    unitWord={unitWord}
                    onSaved={load}
                    trigger={
                      <Button variant="outline" className="w-full sm:w-auto">
                        {t('budgets.setLimit')}
                      </Button>
                    }
                  />
                )}
              </div>
              {projectPolicies.length > 0 && (
                <ItemList as="ul" className="mt-3">
                  {projectPolicies.map((policy) => (
                    <Item as="li" key={policy.id} className="flex-wrap gap-x-4 gap-y-1 px-3 py-2.5">
                      <span className="min-w-0 flex-1 truncate text-sm">
                        {projectName(policy.subjectId)}
                      </span>
                      <span className="text-muted-foreground text-xs tabular-nums">
                        {policyLimitLabel(
                          policy,
                          t('budgets.perDay'),
                          t('budgets.perMonth'),
                          formatBare
                        )}
                      </span>
                      <LimitEditor
                        scope="project"
                        subjectId={policy.subjectId as string}
                        subjectLabel={projectName(policy.subjectId)}
                        current={policy}
                        unitWord={unitWord}
                        onSaved={load}
                        trigger={
                          <Button
                            variant="ghost"
                            size="sm"
                            title={t('budgets.setLimit')}
                            aria-label={`${t('budgets.setLimit')}: ${projectName(policy.subjectId)}`}
                          >
                            <Pencil className="text-muted-foreground size-3.5" aria-hidden />
                          </Button>
                        }
                      />
                    </Item>
                  ))}
                </ItemList>
              )}
            </div>
          </>
        )}
      </div>
    </TooltipProvider>
  )
}
