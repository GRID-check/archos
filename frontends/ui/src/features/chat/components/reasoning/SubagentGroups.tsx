/**
 * SubagentGroups — the subagents a turn ran (AG-UI 1.0 `SUBAGENT_*`), as
 * nested groups under the Herleitung graph: who worked, inside whom, how it
 * ended, and how many steps it took. Today that is an in-process deep
 * research and its planner, researchers and writer.
 *
 * It reads the stored steps the turn fold writes and nothing else: a
 * subagent is its own row (`subagent:<run id>`, a technical status whose
 * `subagentRunId` is its parent), and every step it took carries its run id.
 * So the same steps draw the same groups live, after a reload and for an
 * observer. A turn with no subagent draws nothing.
 */

'use client'

import type { FC } from 'react'
import { CircleAlert, CircleCheck, CircleMinus } from 'lucide-react'
import { CountPill } from '@/components/ui/count-pill'
import { SectionLabel } from '@/components/ui/section-label'
import { Spinner } from '@/components/ui/spinner'
import { useTranslations } from '@/i18n'
import { cn } from '@/lib/utils'
import type { StoredThinkingStep } from '@/lib/conversations/message-provenance'
import { subagentStepId } from '../../lib/turn-fold'

/** How a group ended. `ended`: still running when the turn ended, so it never said. */
export type SubagentGroupStatus = 'running' | 'ok' | 'error' | 'ended'

export interface SubagentGroup {
  runId: string
  name: string
  description?: string
  status: SubagentGroupStatus
  /** The steps this invocation took itself, in order; its subagents' steps are theirs. */
  steps: StoredThinkingStep[]
  children: SubagentGroup[]
}

const SUBAGENT_ROW = subagentStepId('')

const groupStatus = (row: StoredThinkingStep): SubagentGroupStatus => {
  const status = row.detail?.status
  if (status === 'ok' || status === 'error') return status
  return row.isComplete ? 'ended' : 'running'
}

const isSubagentRow = (step: StoredThinkingStep): boolean =>
  step.kind === 'status' && step.id.startsWith(SUBAGENT_ROW)

/**
 * The subagent tree of one turn's steps, roots first, each level in the order
 * the invocations started. A step whose invocation's row was dropped (the
 * stored bound) belongs to no group and is not drawn here.
 */
export const subagentGroups = (steps: readonly StoredThinkingStep[]): SubagentGroup[] => {
  const groups = new Map<string, SubagentGroup>()
  const parents = new Map<string, string | undefined>()
  for (const step of steps.filter(isSubagentRow)) {
    const runId = step.id.slice(SUBAGENT_ROW.length)
    const { name, description } = step.detail ?? {}
    groups.set(runId, {
      runId,
      name: typeof name === 'string' ? name : 'subagent',
      ...(typeof description === 'string' ? { description } : {}),
      status: groupStatus(step),
      steps: [],
      children: [],
    })
    parents.set(runId, step.subagentRunId)
  }
  for (const step of steps) {
    if (step.subagentRunId && !isSubagentRow(step)) groups.get(step.subagentRunId)?.steps.push(step)
  }
  const roots: SubagentGroup[] = []
  for (const [runId, group] of groups) {
    const parent = parents.get(runId)
    const home = parent ? groups.get(parent) : undefined
    if (home) home.children.push(group)
    else roots.push(group)
  }
  return roots
}

/** The subagents Piloti names in the reader's words; any other shows its own name. */
const KNOWN_NAMES: Readonly<Record<string, string>> = {
  deep_researcher: 'deepResearcher',
  'planner-agent': 'planner',
  'researcher-agent': 'researcher',
  'writer-agent': 'writer',
  'source-router-agent': 'sourceRouter',
  'general-purpose': 'generalPurpose',
}

type Translate = ReturnType<typeof useTranslations>

const StatusGlyph: FC<{ status: SubagentGroupStatus }> = ({ status }) => {
  if (status === 'running') return <Spinner size="xs" aria-hidden="true" />
  const Icon = status === 'ok' ? CircleCheck : status === 'error' ? CircleAlert : CircleMinus
  const tone = status === 'error' ? 'text-error' : 'text-muted-foreground'
  return <Icon className={`size-3.5 shrink-0 ${tone}`} aria-hidden="true" />
}

const Group: FC<{ group: SubagentGroup; t: Translate }> = ({ group, t }) => {
  const known = KNOWN_NAMES[group.name]
  const name = known ? t(`thinking.subagents.name.${known}`) : group.name
  return (
    <li className="flex flex-col gap-1" data-testid="subagent-group" data-status={group.status}>
      <div className="flex min-h-8 items-center gap-2 text-sm">
        <StatusGlyph status={group.status} />
        <span className={known ? 'text-foreground' : 'text-foreground font-mono'}>{name}</span>
        <span className="text-muted-foreground text-xs">{t(`thinking.subagents.status.${group.status}`)}</span>
        {group.steps.length > 0 && (
          <CountPill>{t('thinking.subagents.steps', { count: group.steps.length })}</CountPill>
        )}
      </div>
      {group.description && (
        <p className="text-muted-foreground line-clamp-2 pl-5.5 text-xs">{group.description}</p>
      )}
      {group.children.length > 0 && (
        <ul className="border-base ml-1.5 flex flex-col gap-1 border-l-2 pl-3">
          {group.children.map((child) => (
            <Group key={child.runId} group={child} t={t} />
          ))}
        </ul>
      )}
    </li>
  )
}

export const SubagentGroups: FC<{ steps: readonly StoredThinkingStep[]; className?: string }> = ({
  steps,
  className,
}) => {
  const t = useTranslations('chat')
  const roots = subagentGroups(steps)
  if (roots.length === 0) return null
  return (
    <section className={cn('flex flex-col gap-2', className)} aria-label={t('thinking.subagents.heading')}>
      <SectionLabel>{t('thinking.subagents.heading')}</SectionLabel>
      <ul className="flex flex-col gap-1">
        {roots.map((group) => (
          <Group key={group.runId} group={group} t={t} />
        ))}
      </ul>
    </section>
  )
}
