'use client'

import {
  type FC,
  type KeyboardEvent,
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react'
import {
  MessageSquareText,
  MoreHorizontal,
  PencilLine,
  Share2,
  SquarePen,
} from 'lucide-react'
import { AnimatePresence, motion, motionQuick } from '@/components/motion'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Spinner } from '@/components/ui/spinner'
import { useAuth } from '@/adapters/auth'
import { useChatStore } from '@/features/chat/store'
import { useConversationOnServer } from '@/features/chat/lib/conversation-on-server'
import { hasLiveRun } from '@/features/chat/lib/session-activity'
import { AccessChip } from '@/features/collaboration/components/AccessChip'
import { ParticipantStrip } from '@/features/collaboration/components/ParticipantStrip'
import { ShareDialog } from '@/features/collaboration/components/ShareDialog'
import { useSharing } from '@/features/collaboration/hooks/use-sharing'
import { cn } from '@/lib/utils'
import { useTranslations } from '@/i18n'
import { chatCopy } from '@/i18n/namespaces/chat'
import { collaborationCopy } from '@/i18n/namespaces/collaboration'
import { researchCopy } from '@/i18n/namespaces/research'
import type { ResourceSharingState } from '@/lib/sharing/types'
import { useHeaderHeight } from '../hooks/use-header-height'
import { useLayoutStore } from '../store'
import { ChatProjectContext } from './ChatProjectContext'

/**
 * How long after opening the editor from the menu a blur is treated as the menu
 * handing focus back rather than the user leaving the field. Also closed by the
 * first keystroke, since `commitTitle`/`cancelTitleEdit` resolve the edit.
 */
const MENU_FOCUS_GUARD_MS = 250

interface ChatToolbarProps {
  sessionTitle?: string
  /**
   * The active project. Named on a phone only, in the context row above the
   * pills (the chat route has no phone header to carry it); on a desktop the
   * composer's scope chip, the rail and the URL name it, so the pills do not.
   */
  projectName?: string | null
  onNewSession?: () => void
  isNewSessionDisabled?: boolean
  /**
   * Whether a chat has actually started (messages present / an active thread).
   * The thread/project breadcrumb, New chat and Research controls only appear
   * once this is true — a fresh, empty chat keeps only the quiet navigation
   * affordances (history door + mobile nav opener). Defaults to true so callers
   * that don't yet pass it (and existing specs) keep the full toolbar.
   */
  isChatStarted?: boolean
  /**
   * The conversation the sharing surfaces act on. Passed in rather than read from
   * the chat store so this component keeps taking its inputs as props (and so a
   * preview or a test can drive it without a store).
   */
  conversationId?: string | null
  /**
   * Whether the collaboration feature is on for this org. **Default `false`**: the
   * gate is default-deny like the API's (`requireCollaborationEnabled`), so a
   * caller that has not been taught about sharing yet opens no request and shows no
   * collaboration furniture.
   */
  isCollaborationEnabled?: boolean
  /** The signed-in user, so the roster can mark "you" and Leave knows its target. */
  currentUserId?: string | null
  /**
   * Called with the toolbar's height whenever it changes. The toolbar floats over
   * the transcript, so whoever lays the transcript out needs to know how far down
   * it ends (see `toolbar-clearance.ts`).
   */
  onHeightChange?: (heightPx: number) => void
}

export const ChatToolbar: FC<ChatToolbarProps> = memo(function ChatToolbar({
  sessionTitle = '',
  projectName = null,
  onNewSession,
  isNewSessionDisabled = false,
  isChatStarted = true,
  conversationId = null,
  isCollaborationEnabled = false,
  currentUserId = null,
  onHeightChange,
}) {
  const { isAuthenticated } = useAuth()
  const headerRef = useHeaderHeight(onHeightChange)
  const t = useTranslations(researchCopy)
  const tChat = useTranslations(chatCopy)
  const tCollab = useTranslations(collaborationCopy)
  const toggleSessionsPanel = useLayoutStore((s) => s.toggleSessionsPanel)
  // A run going in THIS thread, read off its stored ledger (ADR-0062).
  const isDeepResearchStreaming = useChatStore((s) =>
    hasLiveRun(s.currentConversation?.messages ?? [])
  )
  // Inline rename reuses the SAME store action the sessions panel uses.
  const currentSessionId = useChatStore((s) => s.currentConversation?.id)
  const updateConversationTitle = useChatStore((s) => s.updateConversationTitle)

  // Sharing state for this thread. One request per conversation, shared by the
  // strip, the chip and the dialog — the hook is fully inert while the feature is
  // off or there is no reachable conversation (no fetch, no live subscription).
  // A chat started here is on the server only once its first message has been
  // stored, and the header appears with that message — asking before the create
  // lands is answered 404.
  const isConversationOnServer = useConversationOnServer(conversationId)
  const isSharingReachable = Boolean(
    isCollaborationEnabled &&
      isAuthenticated &&
      isChatStarted &&
      conversationId &&
      isConversationOnServer,
  )
  const sharing = useSharing('conversation', conversationId ?? null, isSharingReachable)
  const [isShareOpen, setIsShareOpen] = useState(false)
  // Only render the collaboration affordances once the server has actually told us
  // about this thread. A chip guessing "Privat" before the answer arrives would be
  // a claim about access control made without evidence.
  const sharingState = isSharingReachable ? sharing.state : null
  // A failed load must not make Share vanish silently — the dialog renders its
  // own retry alert, so the menu item stays reachable while `loadError` is set.
  const canShare = Boolean(sharingState || (isSharingReachable && sharing.loadError))
  // Inline title editing state (Enter commits / Escape cancels / blur commits).
  const [isEditingTitle, setIsEditingTitle] = useState(false)
  const [editedTitle, setEditedTitle] = useState(sessionTitle)
  const titleInputRef = useRef<HTMLInputElement>(null)
  // Blur fires after Escape/Enter too — this ref suppresses the double-commit.
  const editResolvedRef = useRef(false)

  useEffect(() => {
    if (isEditingTitle) {
      titleInputRef.current?.focus()
      titleInputRef.current?.select()
    }
  }, [isEditingTitle])

  const canRename = isAuthenticated && !!currentSessionId && !!updateConversationTitle

  /**
   * Who can read this thread — answered by exactly ONE of two forms, never both.
   *
   * Which one is not a style choice; it is which form is TRUE of the audience:
   *
   *   `private`            the audience IS the roster. It was enumerated, person
   *                        by person, so the faces are the whole answer and a
   *                        "Geteilt mit 2" chip beside them is that same sentence
   *                        a second time.
   *   `project` / `organization`
   *                        the audience IS the rule. Nobody enumerated it, and it
   *                        keeps changing as people join the project — so faces
   *                        there are not a summary of it but a partial sample of
   *                        it, which reads as "these three can see it" when the
   *                        truth is "everyone in the project can".
   *
   * The named exceptions under a blanket rule are real, and they are shown where
   * there is room to explain them: the sharing surface, which states the rule and
   * the exceptions together (SH-17/SH-18).
   */
  const showFaces = sharingState?.visibility === 'private'
  const showAccessChip = Boolean(sharingState && sharingState.visibility !== 'private')

  // Does the status group have anything to say? A solo private thread has neither
  // form to show — with nothing running, the group would be a bare separator.
  const hasPeople = Boolean(
    showAccessChip || (showFaces && (sharingState?.entries.length ?? 0) > 1),
  )
  const hasStatus = Boolean(isDeepResearchStreaming || hasPeople)

  const startEditingTitle = useCallback(() => {
    if (!canRename) return
    setEditedTitle(sessionTitle)
    editResolvedRef.current = false
    setIsEditingTitle(true)
  }, [canRename, sessionTitle])

  /**
   * Open the inline editor from the menu.
   *
   * Closing a menu returns focus to its trigger, which lands on the editor we just
   * opened as a blur — and blur commits, so the editor opened and closed again
   * before anyone could type in it.
   *
   * Two orderings were tried and both were wrong, because ordering is the wrong
   * tool: deferring the open by a frame put it at the mercy of whatever else owns
   * the frame loop (the pill animates), and deferring by a task still raced the
   * menu's own restoration, so the editor opened *usually*. What is actually true
   * here is simpler — a blur arriving in the first moments after the menu closed
   * is the menu handing focus back, not the user leaving the field. So the editor
   * ignores exactly that blur and takes focus back, and is correct whichever
   * order the two land in. The window is short enough that no real departure can
   * fall inside it (nobody clicks away in a quarter second) and it is closed by
   * the first keystroke regardless.
   */
  const focusGuardUntilRef = useRef(0)

  const startEditingTitleFromMenu = useCallback(() => {
    focusGuardUntilRef.current = Date.now() + MENU_FOCUS_GUARD_MS
    startEditingTitle()
  }, [startEditingTitle])

  const commitTitle = useCallback(() => {
    if (editResolvedRef.current) return
    editResolvedRef.current = true
    setIsEditingTitle(false)
    const trimmed = editedTitle.trim()
    if (trimmed && trimmed !== sessionTitle && currentSessionId && updateConversationTitle) {
      updateConversationTitle(currentSessionId, trimmed)
    }
  }, [editedTitle, sessionTitle, currentSessionId, updateConversationTitle])

  const handleTitleBlur = useCallback(() => {
    // Time-boxed, not once-only: the menu's teardown can reach for focus more than
    // once, so disarming after the first blur just loses the second one.
    if (Date.now() < focusGuardUntilRef.current) {
      // Take focus back on a LATER task. Calling `focus()` from inside the blur
      // dispatch re-enters it, and the two bounce off each other until the stack
      // gives out.
      setTimeout(() => titleInputRef.current?.focus(), 0)
      return
    }
    commitTitle()
  }, [commitTitle])

  const cancelTitleEdit = useCallback(() => {
    editResolvedRef.current = true
    setIsEditingTitle(false)
    setEditedTitle(sessionTitle)
  }, [sessionTitle])

  const handleTitleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        commitTitle()
      } else if (e.key === 'Escape') {
        e.preventDefault()
        cancelTitleEdit()
      }
    },
    [commitTitle, cancelTitleEdit]
  )

  const handleMenuClick = useCallback(() => {
    if (isAuthenticated) toggleSessionsPanel()
  }, [toggleSessionsPanel, isAuthenticated])

  const handleNewSessionClick = useCallback(() => {
    if (!isAuthenticated || isNewSessionDisabled) return
    onNewSession?.()
  }, [isAuthenticated, isNewSessionDisabled, onNewSession])

  return (
    // Floating controls: no band, no background strip. The chat plane runs to
    // the very top edge and scrolls behind these; the controls ride above it as
    // two self-contained pills. `pointer-events-none` on the frame lets clicks
    // fall through the gaps to the messages; each pill re-enables them.
    //
    // The split is by KIND, and it is the thing that keeps the row readable:
    //
    //   LEFT  — orientation. Where am I: past sessions, and this thread's name.
    //           Everything here is elastic and gets ALL the leftover width.
    //   RIGHT — the people in the room and the ways out of it. Everything here
    //           is fixed-width.
    //
    // Mixing the two is what crowded this row. The participant faces and the
    // access chip used to sit in the LEFT pill, "next to what the thread IS" —
    // but they are fixed-width status, so every face was taken directly out of
    // the thread's own title, until on a phone the stack overflowed the pill and
    // clipped the title to a single glyph. Status now sits with the actions,
    // where a fixed width costs the title nothing.
    //
    // The other half of the crowding was duplicate doors. This header does not
    // own the research report: a run is read in the thread that commissioned
    // it, in its run block (ADR-0062), so there is no report toggle here.
    <header ref={headerRef} className="pointer-events-none absolute inset-x-0 top-0 z-20 min-h-12 pb-2 max-md:landscape:flex max-md:landscape:items-start max-md:landscape:gap-2 pl-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))] pt-[max(0.5rem,env(safe-area-inset-top))] sm:pl-[max(1.5rem,env(safe-area-inset-left))] sm:pr-[max(1.5rem,env(safe-area-inset-right))]">
      {/* Phone shell: where the reader is, and search, above the pills. On a phone
          on its side there is width for it beside them, so it stands left of the
          row there instead of taking a line of 393px. */}
      <ChatProjectContext
        projectName={projectName}
        className="mx-auto mb-1 w-full max-w-5xl max-md:landscape:mx-0 max-md:landscape:mb-0 max-md:landscape:w-auto max-md:landscape:max-w-[16rem] max-md:landscape:shrink-0"
      />
      {/* The SAME wide column as the message list and composer (max-w-5xl,
          mx-auto), so the pills stay aligned with the chat window's edges. */}
      <div className="mx-auto flex w-full max-w-5xl items-start justify-between gap-3 max-sm:items-stretch max-md:landscape:mx-0 max-md:landscape:min-w-0 max-md:landscape:flex-1">
      {/* LEFT pill: orientation only — the single history door + the current
          session title/rename, always visible (mobile included). On a phone it
          takes whatever width the right pill leaves, and the title may run to
          two lines inside it rather than being cut to a stub.
          min-h-12 (44px controls) on touch, min-h-8 (28px controls) on a
          pointer device, so the pill never collapses when the breadcrumb is
          hidden on an empty chat. */}
      {/* The alpha pair is load-bearing: this toolbar FLOATS over the scrolling
          transcript, and `backdrop-blur` needs something to blur. The
          `supports-` step drops to a more opaque fill where there is no blur. */}
      {/* Quiet register (the Claude bar, not a toolbar): 32px controls on a
          pointer device, no shadow, a fainter fill — the pill is legibility
          over the scrolling transcript, not furniture of its own. Touch keeps
          the 44px targets. */}
      {/* …and the pill itself is dropped on a chat that has not started. The
          fill, the hairline and the blur are there to keep these controls
          legible over a MOVING transcript; an empty canvas has none, so on the
          start screen they are chrome with no job — and a lone pill on the left
          with nothing opposite it does not read as "quiet", it reads as a
          toolbar with its right half missing. Nothing is added on the right to
          balance it, because nothing there is true yet: no thread to share or
          rename, and New chat on an empty chat is a door back into the room you
          are standing in. The controls stay exactly where they are and lose
          their frame; the row goes quiet on both sides. */}
      <div
        className={cn(
          // Phone: the pill takes every pixel the right pill leaves, so the title
          // is what the row is made of. It was capped at 64% and shared with a
          // hamburger the tab bar's "Mehr" now replaces; at 393px that left room
          // for eight characters.
          'pointer-events-auto flex min-h-12 min-w-0 items-center gap-0.5 rounded-surface p-0.5 max-sm:flex-1 sm:min-h-8',
          isChatStarted &&
            'border border-base bg-card/60 backdrop-blur supports-[backdrop-filter]:bg-card/50'
        )}
      >
        {/* Sessions / history overlay — the one clear door to past sessions
            (the rail keeps its routed History; this doesn't duplicate it). */}
        <Button
          variant="ghost"
          size={isChatStarted ? 'icon' : 'default'}
          className={cn(
            'shrink-0 rounded-control sm:size-7',
            // On a chat that has not started there is no title beside the icon,
            // and a lone glyph under the project pill is a mystery: it says what
            // it opens, on a phone, where there is no hover to say it. The default
            // size, because `icon`'s square width cannot be overridden by a class.
            isChatStarted ? 'size-11' : 'h-11 gap-1.5 px-3 sm:px-0 sm:py-0'
          )}
          onClick={handleMenuClick}
          disabled={!isAuthenticated}
          aria-label={t('chatToolbar.toggleSessions')}
          title={!isAuthenticated ? t('chatToolbar.signInToView') : t('chatToolbar.toggleSessions')}
        >
          <MessageSquareText className="size-4" aria-hidden="true" />
          {!isChatStarted && (
            <span className="text-sm font-medium sm:hidden">{t('chatToolbar.toggleSessions')}</span>
          )}
        </Button>

        {/* The session title (click-to-rename) — shown once a chat has started
            so the current thread is identifiable. On a fresh, empty chat there
            is no thread to name yet, so it stays hidden to keep the start
            screen calm. The PROJECT name is deliberately absent: the composer's
            scope chip, the rail and the URL all name it already, so here it was
            a fourth copy paying rent in the row's scarcest space. */}
        {isChatStarted && (sessionTitle || hasStatus) && (
          <nav
            className="flex min-w-0 flex-1 flex-col justify-center pl-1 pr-1.5 text-sm sm:flex-none sm:flex-row sm:items-center sm:gap-1.5"
            aria-label={tChat('breadcrumb.ariaLabel')}
          >
              <div className="flex min-w-0 flex-1 items-center gap-2 sm:contents">
              {sessionTitle ? (
                isEditingTitle ? (
                  <input
                    ref={titleInputRef}
                    value={editedTitle}
                    onChange={(e) => {
                      // The first keystroke ends the menu-handover guard: once the
                      // user is typing, every blur after it is genuinely theirs.
                      focusGuardUntilRef.current = 0
                      setEditedTitle(e.target.value)
                    }}
                    onKeyDown={handleTitleKeyDown}
                    onBlur={handleTitleBlur}
                    aria-label={tChat('breadcrumb.renameInputAria')}
                    // Enter commits the rename (see `handleTitleKeyDown`), so the
                    // phone's action key says so. A conversation title is a name,
                    // not a sentence: the keyboard must not capitalise or
                    // "correct" what the reader chose to call it.
                    enterKeyHint="done"
                    autoCapitalize="off"
                    autoCorrect="off"
                    spellCheck={false}
                    // The same 16px floor `ui/input.tsx` and the composer carry,
                    // on the same pointer axis: iOS Safari zooms the page whenever
                    // a field under 16px takes focus, and this one opens focused,
                    // at the top of the thread, with the toolbar pinned over the
                    // conversation. The zoom is not undone on blur, so renaming a
                    // chat left the reader magnified inside their own answer.
                    className="h-11 w-56 max-w-full rounded-control border bg-card px-2 text-sm font-medium text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 pointer-coarse:text-base sm:h-7"
                  />
                ) : (
                  // Click-to-rename, kept as the SHORTCUT rather than as the only
                  // way in. On its own it was the header's least honest element:
                  // styled exactly like the label it also was, so nobody could
                  // discover it. The menu entry is now the discoverable path and
                  // this is the fast one for people who know it — which is why it
                  // carries a hover fill and a text cursor, the two hints that make
                  // the click findable for anyone who happens to pass over it.
                  <button
                    type="button"
                    onClick={startEditingTitle}
                    disabled={!canRename}
                    aria-label={tChat('breadcrumb.renameAria')}
                    title={canRename ? tChat('breadcrumb.renameAria') : sessionTitle}
                    className="flex min-h-9 min-w-0 max-w-[420px] flex-1 items-center rounded-control px-1 py-0.5 text-left text-sm font-medium leading-snug text-foreground transition-colors duration-quick ease-out motion-reduce:transition-none enabled:cursor-text enabled:hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 pointer-coarse:min-h-11 sm:flex-none"
                  >
                    {/* Two lines on a phone, one on a pointer device. A name is the
                        first thing a reader checks in a thread; it is never cut to a
                        stub to make room for chrome. */}
                    {/* `hyphens-auto` (the page is `lang="de"`): a German compound breaks at a
                        syllable, never mid-word. */}
                    <span className="line-clamp-2 hyphens-auto break-words sm:line-clamp-1">{sessionTitle}</span>
                  </button>
                )
              ) : null}
              {/* Phone only: what is true of the thread, at the end of the title's
                  own row: who can read it (a small stack of faces, or the rule as
                  a chip) and a spinner while a run is going. The title keeps the
                  width and the pill stays one line of orientation; below `sm`
                  there is no room beside the actions for it. */}
              {hasStatus && (
                <ThreadStatus
                  surface="phone"
                  sharingState={sharingState}
                  currentUserId={currentUserId}
                  isResearching={isDeepResearchStreaming}
                  researchingLabel={t('chatToolbar.researching')}
                  className="flex shrink-0 items-center gap-1.5 pr-0.5 sm:hidden"
                />
              )}
              </div>
          </nav>
        )}

      </div>

      {/* RIGHT pill: what is TRUE about this thread, then what you can DO to it,
          with a hairline between the two. Hidden until a chat has started — on the
          empty start screen New chat is redundant and there is no thread to share
          or rename.

          The separation is the point. This row used to mix the two kinds freely,
          and worse, it mixed them in a way that made each LIE about itself: the
          avatar stack looks like status and was a button, while the access chip
          looks like every other chip in the app and is `role="img"`. A reader
          could not tell what would respond to a click without trying. So:

            · everything before the hairline is INFORMATION. Not clickable, ever.
            · everything after it is a CONTROL, and looks like one.

          The second rule is that only the most frequent control stays in the open.
          New chat earns that. Share, rename and the research report are occasional
          and go in the one menu — progressive disclosure rather than three more
          permanent buttons in a 768px row that also has to carry a thread title.

          Arrivals fade (opacity only). Width is reserved by the controls that
          stay mounted — layout/width animation was a spring that bounced the
          New-chat button sideways. Reduced motion is handled globally by
          <MotionConfig reducedMotion="user">. */}
      {isChatStarted && (
      <div className="pointer-events-auto flex min-h-12 shrink-0 items-center gap-0.5 rounded-surface border border-base bg-card/60 p-0.5 backdrop-blur supports-[backdrop-filter]:bg-card/50 sm:min-h-8">
        {/* ── STATUS ────────────────────────────────────────────────────────────
            Who can reach this thread, stated ONCE, in whichever of the two forms is
            true of the audience (see `showFaces` / `showAccessChip` above), and
            never clickable. A solo private thread gets neither — the same doctrine
            ParticipantStrip already applies to itself: no collaboration furniture
            where nothing is being collaborated on.

            Desktop-only HERE: a phone's width belongs to the thread's name, so
            below `sm` the same status is the line under the name (the left pill).

            The group renders only when it has something to SAY — a hairline with
            nothing in front of it is the same empty claim as the button that
            pointed at an empty report.

            It arrives late by nature (the roster is a fetch), so it fades and
            settles in rather than blinking into place. `initial={false}` on the
            presence keeps that for CHANGES only: a thread you open with the roster
            already known must not replay the animation. */}
        <AnimatePresence initial={false}>
        {hasStatus && (
          <motion.div
            key="status"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={motionQuick}
            className="hidden items-center gap-1 pl-1 pr-1.5 sm:flex"
          >
            <ThreadStatus
              surface="desktop"
              sharingState={sharingState}
              currentUserId={currentUserId}
              isResearching={isDeepResearchStreaming}
              researchingLabel={t('chatToolbar.researching')}
              className="contents"
            />
            <div aria-hidden="true" className="ml-1 h-4 w-px bg-border" />
          </motion.div>
        )}
        </AnimatePresence>

        {/* ── CONTROLS ─────────────────────────────────────────────────────────
            New chat: the one action frequent enough to stay in the open. */}
        <Button
          variant="ghost"
          size="sm"
          // On a phone it is the first entry of the ⋯ menu: the right pill is one
          // 44px square, and the title keeps the rest of the row.
          className="size-11 gap-1.5 rounded-control px-0 max-sm:hidden sm:h-7 sm:w-auto sm:px-2"
          onClick={handleNewSessionClick}
          disabled={!isAuthenticated || isNewSessionDisabled}
          aria-label={t('chatToolbar.createNewSession')}
          title={
            !isAuthenticated
              ? t('chatToolbar.signInToCreate')
              : isNewSessionDisabled
                ? t('chatToolbar.cannotCreateActive')
                : t('chatToolbar.createNewSession')
          }
        >
          <SquarePen className="size-4" aria-hidden="true" />
          <span className="hidden text-xs font-medium sm:inline">{t('chatToolbar.newChat')}</span>
        </Button>

        {/* Everything else this thread can do. Each item is here because it is
            occasional, and each still appears only when it is real.

            Its own hairline: the same mark that separates what is TRUE from what
            you can DO now also separates the one action kept in the open from the
            drawer holding the rest, so the pill reads as three plain groups
            instead of a run of controls. Drawn only with the menu it precedes —
            a divider with nothing after it is a promise of something missing. */}
        {(canRename || canShare || isAuthenticated) && (
          <>
          <div aria-hidden="true" className="mx-1 h-4 w-px bg-border max-sm:hidden" />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                // Square, and the SAME height as every other control in both
                // pills — 44px where a finger has to land it, 28px on a pointer
                // device. The two pills are only as tall as their tallest control,
                // so any control that opts out of this pair makes one pill taller
                // than the other and the row stops lining up.
                size="sm"
                className={cn(
                  'size-11 rounded-control px-0 sm:size-7',
                  // Nothing to disclose on a desktop (New chat is in the open there):
                  // the trigger is the phone's alone.
                  !(canRename || canShare) && 'sm:hidden'
                )}
                aria-label={t('chatToolbar.moreActions')}
                title={t('chatToolbar.moreActions')}
                data-testid="thread-menu"
              >
                <MoreHorizontal className="size-4" aria-hidden="true" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              {/* New chat, on a phone only: a desktop keeps it in the open. */}
              <DropdownMenuItem
                onSelect={handleNewSessionClick}
                disabled={!isAuthenticated || isNewSessionDisabled}
                className="sm:hidden"
                data-testid="new-chat-menu-item"
              >
                <SquarePen className="size-4" aria-hidden="true" />
                {t('chatToolbar.newChat')}
              </DropdownMenuItem>

              {/* Rename — the discoverable path to the same inline editor the
                  title's own click opens. The click stays as the shortcut; this is
                  how anyone finds out it exists. */}
              {canRename && (
                <DropdownMenuItem
                  onSelect={startEditingTitleFromMenu}
                  data-testid="rename-session"
                >
                  <PencilLine className="size-4" aria-hidden="true" />
                  {t('chatToolbar.renameSession')}
                </DropdownMenuItem>
              )}

              {/* Share — the ONE door to the sharing surface (SH-17). Present for
                  every participant, not only owners: a viewer is entitled to see who
                  else is in the room, and it is where they leave from. Also present
                  after a failed load: the dialog renders the retry alert, a vanished
                  menu item gives the reader nothing. */}
              {canShare && (
                <DropdownMenuItem onSelect={() => setIsShareOpen(true)} data-testid="share-button">
                  <Share2 className="size-4" aria-hidden="true" />
                  {tCollab('sharing.action')}
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
          </>
        )}
      </div>
      )}
      </div>

      {/* The sharing surface itself. Mounted only once the thread is reachable and
          the reader has asked for it, so it costs nothing on every other render.
          `pointer-events-auto` is unnecessary here — the dialog portals out of this
          `pointer-events-none` header. The dialog owns the loading skeleton and the
          load-error retry alert, so it mounts whenever the door is open — not only
          when a state has already landed. */}
      {isSharingReachable && isShareOpen && conversationId && (
        <ShareDialog
          open={isShareOpen}
          onOpenChange={setIsShareOpen}
          resourceId={conversationId}
          sharing={sharing}
          currentUserId={currentUserId}
        />
      )}
    </header>
  )
})

interface ThreadStatusProps {
  /** Which of the two placements this copy is, for tests and for the eye reading the DOM. */
  surface: 'phone' | 'desktop'
  sharingState: ResourceSharingState | null
  currentUserId: string | null
  isResearching: boolean
  researchingLabel: string
  className?: string
}

/**
 * What is TRUE about the thread: who can read it, and whether a run is in
 * flight. One component, two placements — the right pill's status group at
 * `sm` and up, a line under the title below it — so the phone says exactly what
 * the desktop says and the two cannot drift. Information only: nothing here is
 * ever clickable (see the header's rule).
 */
const ThreadStatus: FC<ThreadStatusProps> = ({
  surface,
  sharingState,
  currentUserId,
  isResearching,
  researchingLabel,
  className,
}) => {
  const showFaces = sharingState?.visibility === 'private'
  const showAccessChip = Boolean(sharingState && sharingState.visibility !== 'private')
  return (
    <div className={className} data-status-surface={surface}>
      {/* No `onOpen`: the strip is deliberately inert here. Sharing has ONE door
          in this header and it is the menu item, so the faces can be read as
          what they are. */}
      {showFaces && sharingState && (
        <ParticipantStrip
          entries={sharingState.entries}
          currentUserId={currentUserId}
          maxVisible={surface === 'phone' ? 2 : undefined}
        />
      )}
      {/* On a phone, while a run is going the spinner is the news and the rule
          steps aside, so the title keeps the width (the sharing surface still
          states it). */}
      {showAccessChip && sharingState && !(surface === 'phone' && isResearching) && (
        <AccessChip visibility={sharingState.visibility} />
      )}
      {/* Live research is status too, and the one piece of it worth carrying in
          the header: the thread's own banner scrolls away, and this is then the
          only persistent "still working" signal. It states, it does not act
          (a run is read in the thread it was commissioned from, ADR-0062).
          Independent of sharing: a solo thread researches just as often. */}
      <AnimatePresence initial={false}>
        {isResearching && (
          <motion.span
            key="running"
            // Opacity only — a width tween is layout motion and shoves the
            // New-chat control.
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={motionQuick}
            className="inline-flex items-center gap-1.5 overflow-hidden whitespace-nowrap text-sm text-muted-foreground"
            data-testid="research-running"
          >
            <Spinner size="sm" label={researchingLabel} />
            <span className={surface === 'phone' ? 'sr-only' : 'hidden lg:inline'}>
              {researchingLabel}
            </span>
          </motion.span>
        )}
      </AnimatePresence>
    </div>
  )
}
