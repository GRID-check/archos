'use client'

/**
 * The command palette (⌘K / Ctrl+K) — keyboard-first navigation over things
 * the UI can already do: jump to a project, jump to a section of the current
 * project, and a handful of global actions (new project, organization,
 * profile, theme, sign out). Pure navigation/dispatch; no new capabilities.
 *
 * The project list is fetched lazily from the existing `GET /api/projects`
 * endpoint (the same list the project switcher renders) the first time the
 * palette opens.
 */

import * as React from 'react'
import { usePathname, useRouter } from 'next/navigation'
import { Building2, FolderKanban, LogOut, Moon, Plus, Sun, UserRound } from 'lucide-react'

import { useAuth } from '@/adapters/auth/use-auth'
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from '@/components/ui/command'
import { DialogClose } from '@/components/ui/dialog'
import { useLayoutStore } from '@/features/layout/store'
import { useMediaQuery } from '@/hooks/use-media-query'
import { useTranslations } from '@/i18n'
import { paletteSections } from './project-sections'
import { ShortcutKeys } from './shortcut-keys'
import { LEADER_KEY } from './shortcuts'

interface PaletteProject {
  id: string
  name: string
}

/** Extract the active project id from `/app/projects/{id}[/…]`, if any. */
export function projectIdFromPathname(pathname: string): string | null {
  const match = /^\/app\/projects\/([^/]+)/.exec(pathname)
  return match ? match[1] : null
}

// 44px rows under a finger: they stack with no gap, so the row grows rather
// than borrowing a catchment from its neighbour.
const PALETTE_ITEM_CLASS =
  'transition-colors duration-snap ease-out motion-reduce:transition-none pointer-coarse:min-h-11 pointer-coarse:text-[15px]'

/**
 * On a phone the palette is the whole screen above the keyboard, the shape of
 * a system search: a 44px field at the top, the results under it, and an
 * explicit "Abbrechen", because a phone has no Escape key to close it with.
 * `--visual-viewport-height` is published while the keyboard is up
 * (`useVisualViewport`), so the last result sits on the keyboard's edge rather
 * than behind it. Every rule is behind `max-md:` and marked important, so the
 * desktop palette is untouched and the dialog atom's own phone defaults do not
 * pull it back into a card.
 */
const PHONE_PALETTE_CLASS = [
  'max-md:inset-x-0! max-md:top-0! max-md:bottom-auto! max-md:left-0! max-md:translate-x-0! max-md:translate-y-0!',
  'max-md:h-[var(--visual-viewport-height,100dvh)]! max-md:max-h-none! max-md:w-full! max-md:max-w-none!',
  'max-md:flex! max-md:flex-col max-md:rounded-none! max-md:border-0! max-md:pt-[env(safe-area-inset-top)]',
  'max-md:data-[state=open]:zoom-in-100 max-md:data-[state=closed]:zoom-out-100',
].join(' ')

/** Leader jump keycaps — `g` then the destination's `shortcutKey` / jump target. */
function JumpShortcut({ jumpKey }: { jumpKey: string }) {
  return (
    // Keycaps say nothing to a finger; a hardware keyboard still has the keys.
    <CommandShortcut className="pointer-coarse:hidden">
      <ShortcutKeys
        segments={[
          { kind: 'chord', caps: [LEADER_KEY.toUpperCase()] },
          { kind: 'then' },
          { kind: 'chord', caps: [jumpKey.toUpperCase()] },
        ]}
      />
    </CommandShortcut>
  )
}

export interface CommandPaletteProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Whether sign-out is meaningful (WorkOS auth configured). */
  authRequired: boolean
  /** Whether the organization page is reachable for this user. */
  canViewOrganization: boolean
  /** Whether the project knowledge page is enabled (feature-flagged, default off). */
  showKnowledge?: boolean
  /** Whether the IFC/BIM model page is enabled (`ifc-models`, ADR-0045). */
  showModels?: boolean
  /**
   * Whether the Agent Skills page is enabled (feature-flagged, default off —
   * ADR-0046).
   */
  showSkills?: boolean
  /** Whether the org-wide Archiv is reachable (ADR-0024). */
  canAccessOfficeShelf?: boolean
}

export function CommandPalette({
  open,
  onOpenChange,
  authRequired,
  canViewOrganization,
  showKnowledge = false,
  showModels = false,
  showSkills = false,
  canAccessOfficeShelf = false,
}: CommandPaletteProps) {
  const router = useRouter()
  const pathname = usePathname() ?? ''
  const { signOut } = useAuth()
  const theme = useLayoutStore((s) => s.theme)
  const setTheme = useLayoutStore((s) => s.setTheme)
  const t = useTranslations('shortcuts.palette')
  const tNav = useTranslations('nav')
  const tCommon = useTranslations('common')

  const projectId = projectIdFromPathname(pathname)
  // The ↑ ↓ ↵ Esc legend is for a keyboard. Read off the primary pointer, so a
  // touch tablet past `md` drops it as well as a phone does.
  const finePointer = useMediaQuery('(pointer: fine)')

  // Lazy project list — fetched once, the first time the palette opens.
  const [projects, setProjects] = React.useState<PaletteProject[] | null>(null)
  React.useEffect(() => {
    if (!open || projects !== null) return
    let cancelled = false
    fetch('/api/projects')
      .then(async (res) => (res.ok ? ((await res.json()) as PaletteProject[]) : []))
      .then((rows) => {
        if (!cancelled) setProjects(rows.map((row) => ({ id: row.id, name: row.name })))
      })
      .catch(() => {
        if (!cancelled) setProjects([])
      })
    return () => {
      cancelled = true
    }
  }, [open, projects])

  const runCommand = React.useCallback(
    (action: () => void) => {
      onOpenChange(false)
      action()
    },
    [onOpenChange],
  )

  // "Toggle theme" flips between light and dark; from `system` it flips to
  // the opposite of what the device currently shows. Same store the user
  // menu's theme picker writes.
  const toggleTheme = React.useCallback(() => {
    const prefersDark =
      typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches
    const isDark = theme === 'dark' || (theme === 'system' && prefersDark)
    setTheme(isDark ? 'light' : 'dark')
  }, [theme, setTheme])

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('title')}
      description={t('description')}
      showHints={finePointer}
      className={`motion-reduce:animate-none ${PHONE_PALETTE_CLASS}`}
      hintLabels={{
        move: t('hints.move'),
        open: t('hints.open'),
        close: t('hints.close'),
      }}
    >
      <div className="flex shrink-0 items-center md:contents max-md:border-b max-md:[&_[data-slot=command-input-wrapper]]:border-b-0 max-md:[&_[data-slot=command-input-wrapper]]:flex-1 max-md:[&_[data-slot=command-input-wrapper]]:h-14 max-md:[&_[data-slot=command-input-wrapper]]:bg-transparent!">
        <CommandInput
          placeholder={t('placeholder')}
          // The wrapper's wash is this field's focus signal (and on a phone,
          // the keyboard is); the global `:focus-visible` outline is unlayered
          // and outranks a plain `outline-none`, so it drew a box inside the
          // band the moment the palette opened.
          className="pointer-coarse:text-base outline-none!"
          enterKeyHint="go"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
        />
        <DialogClose className="text-foreground hover:bg-accent focus-visible:ring-ring/60 mr-1 flex h-11 shrink-0 items-center rounded-lg px-3 text-[15px] font-medium outline-none transition-colors duration-quick ease-out focus-visible:ring-2 motion-reduce:transition-none md:hidden">
          {tCommon('actions.cancel')}
        </DialogClose>
      </div>
      <CommandList className="min-h-0 max-md:max-h-none max-md:flex-1 max-md:overscroll-contain">
        <CommandEmpty>{t('empty')}</CommandEmpty>

        {projects !== null && projects.length > 0 && (
          <CommandGroup heading={t('groups.projects')}>
            {projects.map((project) => (
              <CommandItem
                key={project.id}
                value={`project-${project.id} ${project.name}`}
                onSelect={() => runCommand(() => router.push(`/app/projects/${project.id}`))}
                className={PALETTE_ITEM_CLASS}
              >
                <FolderKanban className="text-muted-foreground" aria-hidden />
                <span className="min-w-0 flex-1 truncate">{project.name}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}

        {projectId && (
          <>
            <CommandSeparator />
            <CommandGroup heading={t('groups.currentProject')}>
              {paletteSections({ showKnowledge, showSkills, showModels, canAccessOfficeShelf }).map((item) => {
                const Icon = item.icon
                const label = tNav(`sections.${item.i18nKey}`)
                const href =
                  item.href ??
                  (item.segment
                    ? `/app/projects/${projectId}/${item.segment}`
                    : `/app/projects/${projectId}`)
                return (
                  <CommandItem
                    key={item.key}
                    value={`section-${item.key} ${label}`}
                    onSelect={() => runCommand(() => router.push(href))}
                    className={PALETTE_ITEM_CLASS}
                  >
                    <Icon className="text-muted-foreground" aria-hidden />
                    <span className="min-w-0 flex-1 truncate">{label}</span>
                    {item.shortcutKey ? <JumpShortcut jumpKey={item.shortcutKey} /> : null}
                  </CommandItem>
                )
              })}
            </CommandGroup>
          </>
        )}

        {/* A rule between groups, not above the first one: with no project
            list yet it doubled the field's own bottom edge. */}
        {((projects !== null && projects.length > 0) || projectId) && <CommandSeparator />}
        <CommandGroup heading={t('groups.general')}>
          <CommandItem
            value={`new-project ${tNav('projectSwitcher.newProject')}`}
            onSelect={() => runCommand(() => router.push('/app/projects?new=1'))}
            className={PALETTE_ITEM_CLASS}
          >
            <Plus className="text-muted-foreground" aria-hidden />
            <span className="min-w-0 flex-1 truncate">{tNav('projectSwitcher.newProject')}</span>
          </CommandItem>
          <CommandItem
            value={`all-projects ${tNav('projectSwitcher.allProjects')}`}
            onSelect={() => runCommand(() => router.push('/app/projects'))}
            className={PALETTE_ITEM_CLASS}
          >
            <FolderKanban className="text-muted-foreground" aria-hidden />
            <span className="min-w-0 flex-1 truncate">{tNav('projectSwitcher.allProjects')}</span>
            <JumpShortcut jumpKey="p" />
          </CommandItem>
          {canViewOrganization && (
            <CommandItem
              value={`organization ${tNav('userMenu.organization')}`}
              onSelect={() => runCommand(() => router.push('/app/organization'))}
              className={PALETTE_ITEM_CLASS}
            >
              <Building2 className="text-muted-foreground" aria-hidden />
              <span className="min-w-0 flex-1 truncate">{tNav('userMenu.organization')}</span>
              <JumpShortcut jumpKey="o" />
            </CommandItem>
          )}
          <CommandItem
            value={`profile ${tNav('userMenu.profile')}`}
            onSelect={() => runCommand(() => router.push('/app/profile'))}
            className={PALETTE_ITEM_CLASS}
          >
            <UserRound className="text-muted-foreground" aria-hidden />
            <span className="min-w-0 flex-1 truncate">{tNav('userMenu.profile')}</span>
          </CommandItem>
          <CommandItem
            value={`toggle-theme ${t('toggleTheme')}`}
            onSelect={() => runCommand(toggleTheme)}
            className={PALETTE_ITEM_CLASS}
          >
            {theme === 'dark' ? (
              <Sun className="text-muted-foreground" aria-hidden />
            ) : (
              <Moon className="text-muted-foreground" aria-hidden />
            )}
            <span className="min-w-0 flex-1 truncate">{t('toggleTheme')}</span>
          </CommandItem>
          {authRequired && (
            <CommandItem
              value={`sign-out ${tCommon('actions.signOut')}`}
              onSelect={() => runCommand(() => void signOut())}
              className={PALETTE_ITEM_CLASS}
            >
              <LogOut className="text-muted-foreground" aria-hidden />
              <span className="min-w-0 flex-1 truncate">{tCommon('actions.signOut')}</span>
            </CommandItem>
          )}
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  )
}
