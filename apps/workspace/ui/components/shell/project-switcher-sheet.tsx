'use client'

/**
 * The project switcher on a phone: a bottom sheet, one tap from anywhere in a
 * project.
 *
 * The desktop switcher is a dropdown at the top of the rail. On a phone that
 * rail is a drawer, so a switch was two stretches to the top of the screen
 * (open the drawer, open the dropdown) followed by a 32px row. Here the
 * project name in the header is the door, the list rises from the bottom where
 * the thumb already is, and every row is 56px.
 *
 * ORDER. The projects this reader opened last come first (`recent-projects`),
 * because on site the switch is almost always between the two or three
 * projects of this week; then every other running project by name. Typing
 * folds both into one list of matches. "Alle Projekte" at the foot goes to the
 * projects home, where closed projects and the full search live.
 *
 * The sheet does not focus its search field on open. Focus would raise the
 * keyboard over the very rows the reader opened the sheet to tap; the field is
 * one tap away for the reader who wants it.
 */

import type { JSX } from 'react'
import * as React from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Check, ChevronRight } from 'lucide-react'

import { FOCUS_RING_INSET } from '@/components/ui/focus-ring'
import { PRESSABLE } from '@/components/ui/press'
import { SearchField } from '@/components/ui/search-field'
import { SectionLabel } from '@/components/ui/section-label'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { useTranslations } from '@/i18n'
import { navCopy } from '@/i18n/namespaces/nav'
import { projectsCopy } from '@/i18n/namespaces/projects'
import { foldDiacritics } from '@/lib/text/latinize'
import { cn } from '@/lib/utils'
import {
  ProjectStatusDot,
  switchableProjects,
  type ProjectSwitcherProject,
} from './project-switcher'
import { readRecentProjectIds } from './recent-projects'
import { useShellOverlays } from './shell-overlays'

/** How many recent projects lead the list. Three is a week on site, not a history. */
const RECENT_SLOTS = 3

export type SwitcherSheetSections =
  | { kind: 'browse'; recent: ProjectSwitcherProject[]; rest: ProjectSwitcherProject[] }
  | { kind: 'search'; matches: ProjectSwitcherProject[] }

function fold(value: string): string {
  return foldDiacritics(value).toLowerCase()
}

/**
 * What the sheet lists. Pure, so the ordering rules are tested without a
 * browser: recents first (in the order they were opened, only ones still
 * offered), then the rest by the order the server sent (name); a query folds
 * case and diacritics, so "muhlgasse" finds „Mühlgasse".
 */
export function switcherSheetSections(
  projects: readonly ProjectSwitcherProject[],
  currentId: string | undefined,
  recentIds: readonly string[],
  query: string
): SwitcherSheetSections {
  const offered = switchableProjects(projects, currentId)
  const needle = fold(query.trim())
  if (needle) {
    return {
      kind: 'search',
      matches: offered.filter((project) => fold(project.name).includes(needle)),
    }
  }
  const byId = new Map(offered.map((project) => [project.id, project]))
  const recent = recentIds
    .map((id) => byId.get(id))
    .filter((project): project is ProjectSwitcherProject => project !== undefined)
    .slice(0, RECENT_SLOTS)
  const recentSet = new Set(recent.map((project) => project.id))
  return { kind: 'browse', recent, rest: offered.filter((project) => !recentSet.has(project.id)) }
}

export interface ProjectSwitcherSheetProps {
  projects: ProjectSwitcherProject[]
  activeProjectId?: string
}

export function ProjectSwitcherSheet({
  projects,
  activeProjectId,
}: ProjectSwitcherSheetProps): JSX.Element {
  const t = useTranslations(navCopy)
  const router = useRouter()
  const open = useShellOverlays((s) => s.projectSheetOpen)
  const setOpen = useShellOverlays((s) => s.setProjectSheetOpen)
  const [query, setQuery] = React.useState('')
  const [recentIds, setRecentIds] = React.useState<string[]>([])
  const contentRef = React.useRef<HTMLDivElement>(null)

  // Read on every open, not once: the reader may have moved between projects
  // since the sheet last stood.
  React.useEffect(() => {
    if (!open) return
    setRecentIds(readRecentProjectIds())
    setQuery('')
  }, [open])

  const sections = switcherSheetSections(projects, activeProjectId, recentIds, query)
  const choose = (projectId: string): void => {
    setOpen(false)
    // Switching into a project lands on its chat, as the desktop switcher does.
    if (projectId !== activeProjectId) router.push(`/app/projects/${projectId}/chat`)
  }
  const row = (project: ProjectSwitcherProject): JSX.Element => (
    <SwitcherRow
      key={project.id}
      project={project}
      current={project.id === activeProjectId}
      onChoose={() => choose(project.id)}
    />
  )

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetContent
        ref={contentRef}
        side="bottom"
        closeLabel={t('projectSheet.close')}
        data-slot="project-switcher-sheet"
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          contentRef.current?.focus()
        }}
        className={cn(
          'gap-0 overflow-hidden rounded-surface p-0 outline-none',
          // Never taller than what the keyboard leaves, so the field and the
          // first matches stay in view while the reader types.
          'h-[min(85dvh,var(--visual-viewport-height,100dvh))] max-h-none',
          'pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)]'
        )}
      >
        <div aria-hidden className="bg-border mx-auto mt-2 h-1 w-9 shrink-0 rounded-full" />
        <SheetHeader className="shrink-0 gap-0.5 px-4 pb-3 pt-3">
          <SheetTitle className="text-base font-semibold tracking-tight">
            {t('projectSwitcher.switchHeading')}
          </SheetTitle>
          <SheetDescription className="sr-only">{t('projectSheet.description')}</SheetDescription>
        </SheetHeader>
        <div className="shrink-0 px-4 pb-2">
          <SearchField
            value={query}
            onChange={setQuery}
            label={t('projectSheet.searchLabel')}
            placeholder={t('projectSheet.searchPlaceholder')}
            clearLabel={t('projectSheet.clearSearch')}
            type="search"
          />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-2">
          {sections.kind === 'search' ? (
            sections.matches.length > 0 ? (
              <ul aria-label={t('projectSheet.matches')}>{sections.matches.map(row)}</ul>
            ) : (
              <p className="text-muted-foreground px-4 py-8 text-center text-sm">
                {t('projectSheet.noMatch')}
              </p>
            )
          ) : (
            <>
              {sections.recent.length > 0 && (
                <SwitcherGroup label={t('projectSheet.recent')}>
                  {sections.recent.map(row)}
                </SwitcherGroup>
              )}
              {sections.rest.length > 0 && (
                <SwitcherGroup
                  label={
                    sections.recent.length > 0
                      ? t('projectSheet.others')
                      : t('projectSwitcher.projects')
                  }
                >
                  {sections.rest.map(row)}
                </SwitcherGroup>
              )}
            </>
          )}
        </div>
        <div className="border-border shrink-0 border-t">
          <Link
            href="/app/projects"
            onClick={() => setOpen(false)}
            className={cn(
              'text-foreground flex min-h-14 items-center gap-3 px-4 text-sm font-medium outline-none',
              PRESSABLE,
              FOCUS_RING_INSET,
              'active:bg-accent'
            )}
          >
            <span className="min-w-0 flex-1">{t('projectSwitcher.viewAllProjects')}</span>
            <ChevronRight className="text-muted-foreground size-4 shrink-0" aria-hidden />
          </Link>
        </div>
      </SheetContent>
    </Sheet>
  )
}

function SwitcherGroup({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}): JSX.Element {
  const id = React.useId()
  return (
    <section aria-labelledby={id} className="pt-2">
      <SectionLabel as="h3" id={id} className="block px-4 pb-1 pt-2">
        {label}
      </SectionLabel>
      <ul>{children}</ul>
    </section>
  )
}

function SwitcherRow({
  project,
  current,
  onChoose,
}: {
  project: ProjectSwitcherProject
  current: boolean
  onChoose: () => void
}): JSX.Element {
  const tProjects = useTranslations(projectsCopy)
  const quiet = project.status === 'paused' || project.status === 'closed'
  return (
    <li>
      <button
        type="button"
        onClick={onChoose}
        aria-current={current ? 'true' : undefined}
        className={cn(
          'flex min-h-14 w-full items-center gap-3 px-4 text-left outline-none',
          PRESSABLE,
          FOCUS_RING_INSET,
          'active:bg-accent'
        )}
      >
        <ProjectStatusDot active={current} />
        <span
          className={cn(
            'min-w-0 flex-1 truncate text-[15px]',
            current ? 'text-foreground font-medium' : 'text-foreground/90'
          )}
        >
          {project.name}
        </span>
        {quiet && project.status && (
          <span className="text-muted-foreground shrink-0 text-xs">
            {tProjects(`card.status.${project.status}`)}
          </span>
        )}
        {current && <Check className="text-foreground size-4 shrink-0" aria-hidden />}
      </button>
    </li>
  )
}
