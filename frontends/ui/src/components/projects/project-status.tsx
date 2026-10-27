'use client'

/**
 * Project status: the derivation helper and the chip (ADR-0098, ADR-0090).
 *
 * A project is `active`, `paused` or `closed` (`projects.status`, migrations
 * 0116 and 0129); a closed one says whether it was completed or not realized. A
 * soft-deleted project never reaches a surface that shows this chip; it lives in
 * the "Recently deleted" panel.
 *
 * Two chips, one decision each:
 *   - {@link ProjectStatusChip}: the project's own status, where a project is
 *     named (card, row, the Overview's hero), and only when it is NOT active:
 *     active is the normal case, and a chip on every row says nothing.
 *   - {@link ProjectClosedChip}: on a FILE, wherever it appears, to say which
 *     closed project it belongs to. A file of an active project carries
 *     nothing; the project it is in is the page around it.
 */

import type { JSX } from 'react'
import type { CSSProperties } from 'react'
import { Activity, Lock, PauseCircle } from 'lucide-react'
import { Chip } from '@/components/ui/chip'
import type { Project } from '@/lib/db/schema/projects'
import { toProjectStatus, type ProjectOutcome, type ProjectStatus } from '@/lib/projects/project-status'
import { useTranslations } from '@/i18n'
import { projectsCopy } from '@/i18n/namespaces/projects'

export type { ProjectStatus }

/** The display status of a project that reached a surface. */
export function getProjectStatus(project: Pick<Project, 'status'>): ProjectStatus {
  return toProjectStatus(project.status)
}

/**
 * Status colors via the `--status-*` token family (spec §4), with the semantic
 * success tokens as the fallback for `active`. A closed project is quiet: the
 * muted chip carries it, and the lock icon says what closed means.
 */
const STATUS_STYLE: Record<ProjectStatus, CSSProperties | undefined> = {
  active: {
    backgroundColor:
      'var(--status-active-tint, color-mix(in oklch, var(--status-active, var(--text-color-feedback-success)) 14%, transparent))',
    color: 'var(--status-active-text, var(--status-active, var(--text-color-feedback-success)))',
  },
  paused: undefined,
  closed: undefined,
}

const STATUS_VARIANT: Record<ProjectStatus, 'success' | 'muted' | 'outline'> = {
  active: 'success',
  paused: 'outline',
  closed: 'muted',
}

const STATUS_ICON: Record<ProjectStatus, typeof Activity> = {
  active: Activity,
  paused: PauseCircle,
  closed: Lock,
}

interface ProjectStatusChipProps {
  status: ProjectStatus
  /** How a closed project ended: a project that was not realized says so. */
  outcome?: ProjectOutcome | null
  size?: 'sm' | 'md'
}

/** Small status chip: Aktiv, Ruhend, Abgeschlossen, or Nicht realisiert. */
export function ProjectStatusChip({ status, outcome = null, size = 'md' }: ProjectStatusChipProps): JSX.Element {
  const t = useTranslations(projectsCopy)
  const Icon = STATUS_ICON[status]
  const label = status === 'closed' && outcome === 'cancelled' ? t('card.status.cancelled') : t(`card.status.${status}`)
  return (
    <Chip variant={STATUS_VARIANT[status]} size={size} style={STATUS_STYLE[status]}>
      <Icon aria-hidden />
      {label}
    </Chip>
  )
}

/** The chip a named project carries: none while it is active. */
export function ProjectStatusMark({
  project,
  size = 'sm',
}: {
  project: Pick<Project, 'status' | 'closedOutcome'>
  size?: 'sm' | 'md'
}): JSX.Element | null {
  const status = getProjectStatus(project)
  if (status === 'active') return null
  return <ProjectStatusChip status={status} outcome={project.closedOutcome} size={size} />
}

/**
 * A file's project, said to be closed: „Projekt Seestadt · abgeschlossen".
 * The name is the project's; without one the chip says only that it is closed.
 */
export function ProjectClosedChip({ projectName, className }: { projectName?: string | null; className?: string }): JSX.Element {
  const t = useTranslations(projectsCopy)
  const label = projectName ? t('lifecycle.fileChip', { name: projectName }) : t('lifecycle.fileChipNoName')
  return (
    <Chip variant="muted" size="sm" className={className} title={label}>
      <Lock aria-hidden />
      <span className="max-w-[16rem] truncate">{label}</span>
    </Chip>
  )
}
