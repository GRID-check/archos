'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { ChevronDown, Settings } from 'lucide-react'

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useLayoutStore } from '@/features/layout/store'
import { useIsMobile } from '@/hooks/use-is-mobile'
import { useTranslations } from '@/i18n'
import type { ProjectStatus } from '@/lib/projects/project-status'
import { cn } from '@/lib/utils'
import { useShellOverlays } from './shell-overlays'

export interface ProjectSwitcherProject {
  id: string
  name: string
  /** Absent reads as active. */
  status?: ProjectStatus
}

/**
 * The projects the switcher offers: where one works. Every member reads every
 * closed project (ADR-0090), so listing them would bury the dozen running ones
 * under everything the office ever finished; a closed project is reached from
 * the projects list, and stays here only while it is the one open (ADR-0098).
 */
export function switchableProjects(projects: readonly ProjectSwitcherProject[], currentId?: string): ProjectSwitcherProject[] {
  return projects.filter((project) => project.status !== 'closed' || project.id === currentId)
}

export interface ProjectSwitcherProps {
  projects: ProjectSwitcherProject[]
  activeProjectId?: string
  collapsed?: boolean
}

/**
 * A small dashed-ring status dot — the click dummy's project marker. Green
 * (`--status-active`) for the active project, quiet ink otherwise. The color
 * always travels with the project label beside it, never alone.
 */
export function ProjectStatusDot({ active }: { active?: boolean }) {
  const color = active ? 'var(--status-active)' : 'var(--muted-foreground)'
  return (
    <span
      className="flex size-3.5 shrink-0 items-center justify-center rounded-full border border-dashed"
      style={{ borderColor: color }}
      aria-hidden
    >
      <span className="size-[5px] rounded-full" style={{ backgroundColor: color }} />
    </span>
  )
}

const TRIGGER_CLASS = cn(
  'flex h-9 w-full items-center gap-2.5 rounded-[10px] border border-border bg-card px-3 text-left shadow-xs pointer-coarse:h-11',
  'transition-[color,background-color,border-color,box-shadow,transform] duration-quick ease-out',
  'hover:bg-accent active:scale-[0.98] motion-reduce:transition-none',
  'focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-offset-2 focus-visible:ring-offset-background focus-visible:outline-none',
)

export function ProjectSwitcher({ projects, activeProjectId, collapsed }: ProjectSwitcherProps) {
  const router = useRouter()
  const t = useTranslations('nav')
  const tProjects = useTranslations('projects')
  const active = projects.find((p) => p.id === activeProjectId)
  const offered = switchableProjects(projects, activeProjectId)
  const [open, setOpen] = React.useState(false)
  const isMobile = useIsMobile()
  const setDrawerOpen = useLayoutStore((s) => s.setMobileNavOpen)
  const setSheetOpen = useShellOverlays((s) => s.setProjectSheetOpen)

  const triggerLabel = active
    ? t('projectSwitcher.switchCurrent', { name: active.name })
    : t('projectSwitcher.select')
  const triggerBody = (
    <>
      <ProjectStatusDot active={Boolean(active)} />
      {!collapsed && (
        <>
          <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-foreground">
            {active?.name ?? t('projectSwitcher.select')}
          </span>
          <span
            className={cn(
              'flex size-3.5 shrink-0 transition-transform duration-quick ease-out motion-reduce:transition-none',
              open && 'rotate-180',
            )}
            aria-hidden
          >
            <ChevronDown className="size-3.5 text-muted-foreground" aria-hidden />
          </span>
        </>
      )}
    </>
  )

  // In the phone drawer the switcher is the sheet, not a dropdown: a 240px
  // menu of 32px rows hanging off the top of a drawer is the stretch the sheet
  // exists to remove. The drawer steps aside so one overlay stands at a time.
  if (isMobile) {
    return (
      <button
        type="button"
        className={cn(TRIGGER_CLASS, collapsed && 'w-10 justify-center px-0')}
        aria-label={triggerLabel}
        aria-haspopup="dialog"
        onClick={() => {
          setDrawerOpen(false)
          setSheetOpen(true)
        }}
      >
        {triggerBody}
      </button>
    )
  }

  return (
    <DropdownMenu onOpenChange={setOpen}>
      <DropdownMenuTrigger
        className={cn(TRIGGER_CLASS, collapsed && 'w-10 justify-center px-0')}
        aria-label={triggerLabel}
      >
        {triggerBody}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="bottom" className="w-60 motion-reduce:animate-none">
        <DropdownMenuLabel className="text-[10.5px] font-semibold tracking-[0.05em] text-muted-foreground uppercase">
          {t('projectSwitcher.switchHeading')}
        </DropdownMenuLabel>
        {offered.map((project) => {
          const isCurrent = project.id === activeProjectId
          const quiet = project.status === 'paused' || project.status === 'closed'
          return (
            <DropdownMenuItem
              key={project.id}
              // Switching into a project always lands on its Chat — the
              // project's primary workspace (spec §5).
              onSelect={() => router.push(`/app/projects/${project.id}/chat`)}
              className="gap-2.5 pr-1.5"
            >
              <ProjectStatusDot active={isCurrent} />
              <span
                className={cn(
                  'min-w-0 flex-1 truncate text-[13px]',
                  isCurrent ? 'font-medium text-foreground' : 'text-foreground/90',
                )}
              >
                {project.name}
              </span>
              {quiet && project.status && (
                <span className="text-muted-foreground shrink-0 text-[11px]">{tProjects(`card.status.${project.status}`)}</span>
              )}
              <button
                type="button"
                aria-label={t('projectSwitcher.projectSettings', { name: project.name })}
                onClick={(event) => {
                  event.preventDefault()
                  event.stopPropagation()
                  router.push(`/app/projects/${project.id}/settings`)
                }}
                // ≥44px touch target (a11y) via padding, with the icon kept
                // small; negative margin keeps the row from growing.
                className="-my-2 -mr-1.5 flex size-11 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-[color,background-color,scale] [transition-duration:var(--motion-quick),var(--motion-quick),var(--motion-snap)] ease-out hover:bg-accent hover:text-foreground active:scale-[0.98] motion-reduce:transition-none focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-offset-2 focus-visible:ring-offset-background focus-visible:outline-none"
              >
                <Settings className="size-3.5" aria-hidden />
              </button>
            </DropdownMenuItem>
          )
        })}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={() => router.push('/app/projects')}
          className="text-[13px] font-medium text-foreground"
        >
          {t('projectSwitcher.viewAllProjects')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
