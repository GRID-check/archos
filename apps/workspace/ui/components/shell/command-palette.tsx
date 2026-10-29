'use client'

/**
 * The command palette (⌘K / Ctrl+K) — keyboard-first navigation over things
 * the UI can already do: jump to a project, jump to a section of the current
 * project, and a handful of global actions (new project, organization,
 * profile, theme, sign out), and the workspace search: what is typed is
 * asked of `POST /api/search` as the reader types, and the hits come back
 * grouped by kind, drawn by the search page's own rows (`features/search`).
 *
 * The project list is fetched lazily from the existing `GET /api/projects`
 * endpoint (the same list the project switcher renders) the first time the
 * palette opens.
 */

import * as React from 'react'
import { defaultFilter } from 'cmdk'
import { usePathname, useRouter } from 'next/navigation'
import { Building2, FolderKanban, LogOut, Moon, Plus, Sun, UserRound } from 'lucide-react'

import { useAuth } from '@/adapters/auth/use-auth'
import {
  CommandDialog,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from '@/components/ui/command'
import { DialogClose } from '@/components/ui/dialog'
import { useHeightGlide } from '@/components/motion/height-glide'
import { useLayoutStore } from '@/features/layout/store'
import {
  PALETTE_ALL_RESULTS_VALUE,
  PALETTE_LATE_ANSWER_MS,
  PALETTE_LATE_HOLD_MS,
  PALETTE_RETRY_VALUE,
  paletteHitHref,
  paletteHits,
  PaletteSearchResults,
  PaletteSearchStart,
  captureSavedSearchRun,
  paletteFilter,
  isPaletteHitValue,
  paletteHitValue,
  savedSearchHref,
  searchPageHref,
  usePaletteSearch,
  usePaletteShortcuts,
} from '@/features/search'
import { useIsMobile } from '@/hooks/use-is-mobile'
import { useMediaQuery } from '@/hooks/use-media-query'
import { useDelayedFlag } from '@/hooks/use-transient-flag'
import { useTranslations } from '@/i18n'
import { cn } from '@/lib/utils'
import { commonCopy } from '@/i18n/namespaces/common'
import { navCopy } from '@/i18n/namespaces/nav'
import { shortcutsCopy } from '@/i18n/namespaces/shortcuts'
import { paletteSections } from './project-sections'
import { ShortcutKeys } from './shortcut-keys'
import { LEADER_KEY, MOD } from './shortcuts'

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
// than borrowing a catchment from its neighbour. No colour transition: the
// highlight follows the arrows in the frame they are pressed, as the hits'
// does, and an eased one left two rows half lit on every key.
const PALETTE_ITEM_CLASS = 'pointer-coarse:min-h-11 pointer-coarse:text-[15px]'

/**
 * On a desktop the palette carries search hits as well as commands: a hit is
 * two lines (its name, then where it lives and what it is; the passage only on
 * the row the arrows are on), so the card is wider than a command list needs
 * and stands higher, leaving the list room for every kind's hits and the
 * „Alle Treffer“ row without a scroll.
 */
const DESKTOP_PALETTE_CLASS = 'md:top-[15%] md:max-w-2xl!'

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
  const t = useTranslations(shortcutsCopy, 'palette')
  const tNav = useTranslations(navCopy)
  const tCommon = useTranslations(commonCopy)

  // What the reader typed is also a workspace search: the hits arrive under
  // the field as they type, grouped by kind and drawn as the search page draws
  // them, and the last search row opens all of them (`/app/search?q=…`). In a
  // project the search is that project's.
  const [query, setQuery] = React.useState('')
  React.useEffect(() => {
    if (!open) setQuery('')
  }, [open])
  const words = query.trim()

  const projectId = projectIdFromPathname(pathname)
  const scope = React.useMemo(() => (projectId ? { scope: 'project' as const, projectId } : {}), [projectId])
  const search = usePaletteSearch(query, scope, open)
  const shortcuts = usePaletteShortcuts(open)

  // The row the arrows are on. When hits arrive for what is typed, the first
  // one takes the selection from the „Alle Treffer“ row cmdk put it on, so
  // Enter opens the best hit. A command row the reader moved to is kept, and
  // so is a hit they arrowed to since they last typed, while the answer for
  // those words still holds it. Any other hit is the palette's own earlier
  // choice and gives way: after a refine it may be second now, and Enter would
  // open it over the new best.
  const [selected, setSelected] = React.useState('')
  // Whether the row the arrows are on is one the reader moved to since they
  // last typed. A row the palette chose for an earlier answer (its best hit,
  // „Alle Treffer“) is no choice of theirs, so an Enter on it waits too.
  const movedByReader = React.useRef(false)
  React.useEffect(() => {
    movedByReader.current = false
  }, [words])
  const answerHits = React.useMemo(
    () => (search.answered === words && search.response ? paletteHits(search.response).map(paletteHitValue) : []),
    [search.answered, search.response, words],
  )
  const firstHit = answerHits[0] ?? null
  React.useEffect(() => {
    if (!firstHit) return
    setSelected((current) =>
      current === '' ||
      current === PALETTE_ALL_RESULTS_VALUE ||
      (isPaletteHitValue(current) && !(movedByReader.current && answerHits.includes(current)))
        ? firstHit
        : current,
    )
  }, [firstHit, answerHits])
  // A failed answer puts the arrows on „Erneut versuchen“, so Enter asks again.
  React.useEffect(() => {
    if (search.failed) setSelected(PALETTE_RETRY_VALUE)
  }, [search.failed])
  const filter = React.useMemo(() => paletteFilter(defaultFilter), [])
  // Nothing to open all of: the footer leaves out its „alle Treffer“.
  const answeredEmpty = words !== '' && (search.failed || (search.answered === words && search.response !== null && firstHit === null))

  const { opening } = search
  const openSearchHref = React.useCallback(
    (href: string) => {
      if (words) shortcuts.remember(words)
      opening(href)
      onOpenChange(false)
      router.push(href)
    },
    [words, shortcuts, opening, onOpenChange, router],
  )
  // Mod+Enter opens every hit for what is typed from whichever row the arrows
  // are on, so the search page is one chord away and never a scroll.
  const allHref = words ? searchPageHref(words, projectId) : null
  // An Enter pressed before the first answer for what is typed is held for
  // it: then it opens the best hit, as it would a moment later, or the search
  // page when there is none. Taken at once it opened whatever row the network
  // had got to, so the same keys went to two places depending on its speed.
  const awaitingAnswer = words !== '' && !search.failed && (search.loading || search.answered !== words)
  const [heldEnter, setHeldEnter] = React.useState<string | null>(null)
  React.useEffect(() => {
    if (heldEnter === null) return
    if (heldEnter !== words || search.failed) {
      setHeldEnter(null)
      return
    }
    if (awaitingAnswer) return
    setHeldEnter(null)
    openSearchHref(firstHit ? paletteHitHref(firstHit) : searchPageHref(words, projectId))
  }, [heldEnter, words, search.failed, awaitingAnswer, firstHit, openSearchHref, projectId])
  const onFieldKeyDown = React.useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        // Moving on is a new choice: a held Enter must not open the best hit over it.
        movedByReader.current = true
        setHeldEnter(null)
      }
      if (event.key !== 'Enter') return
      const chord = event.metaKey || event.ctrlKey
      if (chord && allHref) {
        // cmdk skips its own Enter (select the active row) once this is handled.
        event.preventDefault()
        openSearchHref(allHref)
        return
      }
      if (!chord && awaitingAnswer && !movedByReader.current && (selected === PALETTE_ALL_RESULTS_VALUE || isPaletteHitValue(selected))) {
        event.preventDefault()
        setHeldEnter(words)
      }
    },
    [allHref, openSearchHref, awaitingAnswer, selected, words],
  )
  // The ↑ ↓ ↵ Esc legend is for a keyboard. Read off the primary pointer, so a
  // touch tablet past `md` drops it as well as a phone does.
  const finePointer = useMediaQuery('(pointer: fine)')

  // The field's progress line, once a search has run long enough to be worth
  // saying: the debounce and a quick answer stay under it.
  // Before the first answer the placeholder rows say it already, so the line
  // is for a newer question over hits that stand.
  const searching = useDelayedFlag(
    words !== '' && !search.failed && search.response !== null && (search.loading || search.answered !== words),
    PALETTE_LATE_ANSWER_MS,
    PALETTE_LATE_HOLD_MS
  )

  // On a desktop the card's height follows its content: the commands give way
  // to the placeholder, the placeholder rows to the answer, one answer to the next.
  // Landed in one frame, the card's bottom edge jumped by a hundred pixels on
  // each; glided (`useHeightGlide`, a swap in the frame the reader is looking
  // at), the change reads as the list answering. Keyed by the answer, so the
  // commands the filter drops per key still land at once. On a phone the list
  // fills the screen above the keyboard and has no height of its own to glide.
  const desktop = !useIsMobile()
  // The list mounts a render after the dialog (Radix portals in a layout
  // effect) and again on each open, so the glide gets a ref per element: one
  // made once and read too early never saw the list, and never glided.
  const [listElement, setListElement] = React.useState<HTMLDivElement | null>(null)
  const listRef = React.useMemo(() => ({ current: listElement }), [listElement])
  // The bottom edge dissolves only while there is more under it: on a list
  // that fits, the fade smeared its last row, which was often the selected one.
  // While the first answer for what is typed is on its way the list does not
  // shrink: the commands the words stop matching drop out key by key, and each
  // drop moved the card's bottom edge a moment before the answer moved it
  // again. Held at its tallest, the answer's glide is the one change.
  const awaitingFirst = desktop && open && words !== '' && !search.failed && search.response === null
  const floor = React.useRef(0)
  React.useLayoutEffect(() => {
    if (!listElement) return
    if (!awaitingFirst) {
      floor.current = 0
      if (listElement.firstElementChild instanceof HTMLElement) listElement.firstElementChild.style.minHeight = ''
      return
    }
    // On the list's sizer, which stacks its rows in a column while it waits,
    // so the placeholder grows into the held height rather than leaving it
    // empty under „Alle Treffer“.
    const sizer = listElement.firstElementChild
    // Mid-glide the list's height is pinned to a frame of the glide, which is
    // no measure of what it shows; the next render after it settles is.
    if (!(sizer instanceof HTMLElement) || listElement.style.height !== '') return
    // Never taller than the list shows: a floor measured while the commands
    // overflowed it pushed „Alle Treffer“ below the fold under the placeholder.
    const { paddingTop, paddingBottom } = getComputedStyle(listElement)
    const visible = listElement.clientHeight - parseFloat(paddingTop) - parseFloat(paddingBottom)
    floor.current = Math.min(Math.max(floor.current, sizer.offsetHeight), visible)
    sizer.style.minHeight = `${floor.current}px`
  })
  const [overflows, setOverflows] = React.useState(false)
  React.useLayoutEffect(() => {
    if (!listElement || typeof ResizeObserver === 'undefined') return
    const measure = () => setOverflows(listElement.scrollHeight > listElement.clientHeight + 1)
    const observer = new ResizeObserver(measure)
    observer.observe(listElement)
    if (listElement.firstElementChild) observer.observe(listElement.firstElementChild)
    measure()
    return () => observer.disconnect()
  }, [listElement])
  // Keyed by the answer and by `loading`, never by the keystroke: cmdk filters
  // its rows a render after ours, so a glide keyed by the keystroke measured
  // the unfiltered list, grew toward it and dropped back. `loading` turns on in
  // the render where the commands are filtered and the placeholder arrives, so
  // the first key glides too; later keys while it stays on land at once.
  useHeightGlide(listRef, desktop && open ? `${search.answered}|${search.loading}` : null)

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
      className={`motion-reduce:animate-none ${DESKTOP_PALETTE_CLASS} ${PHONE_PALETTE_CLASS}`}
      commandProps={{ filter, value: selected, onValueChange: setSelected }}
      hintLabels={{
        move: t('hints.move'),
        open: t('hints.open'),
        close: t('hints.close'),
      }}
      // Every hit for what is typed, from whichever row the arrows are on: said
      // once, in the footer where the other keys are, rather than as a second
      // footer pinned over the hits.
      hintsTrailing={
        words && !answeredEmpty ? (
          <>
            <ShortcutKeys segments={[{ kind: 'chord', caps: [MOD, '↵'] }]} />
            {t('hints.all')}
          </>
        ) : null
      }
    >
      <div className="flex shrink-0 items-center md:contents max-md:border-b max-md:[&_[data-slot=command-input-wrapper]]:border-b-0 max-md:[&_[data-slot=command-input-wrapper]]:flex-1 max-md:[&_[data-slot=command-input-wrapper]]:h-14 max-md:[&_[data-slot=command-input-wrapper]]:bg-transparent!">
        <CommandInput
          value={query}
          onValueChange={setQuery}
          onKeyDown={onFieldKeyDown}
          // A held Enter is said at once: the reader pressed a key and waits on it.
          busy={searching || heldEnter !== null}
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
        <DialogClose className="text-foreground hover:bg-accent focus-visible:ring-ring/60 mr-1 flex h-11 shrink-0 items-center rounded-control px-3 text-[15px] font-medium outline-none transition-colors duration-quick ease-out focus-visible:ring-2 motion-reduce:transition-none md:hidden">
          {tCommon('actions.cancel')}
        </DialogClose>
      </div>
      <CommandList
        ref={setListElement}
        // 44px of fade, not the utility's 24: a group heading cut by the edge sat
        // above a 24px band, legible with no row under it, and read as a layout bug.
        className={cn(overflows && 'md:scroll-fade-bottom md:[--scroll-fade-size:44px]', awaitingFirst && '[&_[cmdk-list-sizer]]:flex [&_[cmdk-list-sizer]]:flex-col', 'min-h-0 md:max-h-[min(60dvh,32rem)] max-md:max-h-none max-md:flex-1 max-md:overscroll-contain')}>
        {/* No „Keine Ergebnisse“: a search row always answers, with the way
            to every hit for what was typed. */}
        {words ? (
          <PaletteSearchResults
            text={query}
            answered={search.answered}
            response={search.response}
            loading={search.loading}
            failed={search.failed}
            onOpen={openSearchHref}
            onRetry={search.retry}
            allHref={allHref ?? searchPageHref(words, projectId)}
            scope={scope}
            itemClassName={PALETTE_ITEM_CLASS}
          />
        ) : (
          <PaletteSearchStart
            inProject={projectId !== null}
            recent={shortcuts.recent}
            saved={shortcuts.saved}
            onRecent={setQuery}
            onSaved={(item) => {
              captureSavedSearchRun(item)
              openSearchHref(savedSearchHref(item))
            }}
            onOpenSearch={() => openSearchHref('/app/search')}
            itemClassName={PALETTE_ITEM_CLASS}
          />
        )}
        <CommandSeparator />

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
