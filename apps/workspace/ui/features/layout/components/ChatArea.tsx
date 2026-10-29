/**
 * ChatArea Component
 *
 * Main chat display area showing messages between user and assistant.
 * Includes the message list and is positioned in the center of the layout.
 *
 * Shows different welcome states based on authentication:
 * - Logged out: Prompt to sign in with CTA button
 * - Logged in: Ready to start chatting
 */

'use client'
import { type FC, memo } from 'react'
import { ArrowDown, Check, WifiOff } from 'lucide-react'
import { cn } from '@/lib/utils'
import { PRESSABLE } from '@/components/ui/press'
import { FOCUS_RING } from '@/components/ui/focus-ring'
import { MentionPeopleProvider } from '@/features/collaboration/context/mention-people'
import { TypingPresence } from '@/features/collaboration/components/TypingPresence'
import {
  AnimatePresence,
  motion,
  motionInstant,
  motionQuick,
  motionSnap,
} from '@/components/motion'
import { MessageListSkeleton } from './chat-area/chat-area-states'
import { useChatAreaController } from './chat-area/use-chat-area-controller'
import type { ChatAreaProps } from './chat-area/use-chat-area-controller'
import { ChatMessageList } from './chat-area/chat-message-list'

/**
 * Main chat area container with scrollable message list.
 * Shows welcome state when no messages exist.
 */
export const ChatArea: FC<ChatAreaProps> = memo(function ChatArea(props) {
  const controller = useChatAreaController(props)

  return (
    <MentionPeopleProvider
      participants={controller.participants}
      currentUserId={controller.currentUserId}
      agentName={controller.tCollaboration('mentions.picker.agentName')}
      enabled={controller.shared}
    >
      {/* Non-scrolling wrapper: anchors the floating "scroll to latest" button so
          it stays pinned to the viewport instead of scrolling away with content. */}
      <div className="relative flex min-h-0 flex-1 flex-col">
        <div
          ref={controller.scrollContainerRef}
          onScroll={controller.handleScroll}
          className="scrollbar-hide flex flex-1 flex-col overflow-y-auto overscroll-contain"
          // A named, focusable region, so a keyboard reader can scroll the
          // thread. Not `role="log"`: a log announces every addition, and the
          // live answer adds words every frame. The settle is announced once,
          // below.
          role="region"
          tabIndex={0}
          aria-label={controller.t('chatArea.ariaMessages')}
        >
          {/* Access revoked while viewing: the fallback shows the local copy, so
              without this the thread simply freezes with no explanation. */}
          {controller.accessLost && (
            <div
              role="status"
              className="text-muted-foreground mx-auto mt-3 w-full max-w-5xl px-4 text-sm sm:px-6"
            >
              {controller.tCollaboration('thread.accessLost')}
            </div>
          )}
          {/* Loading skeleton (C5): the persisted thread hasn't rehydrated yet,
              or the open thread's messages are on their way (`showSkeleton`).
              A lightweight grey-bubble placeholder — never a flash of the
              WelcomeState for a reader whose conversation is about to load in.
              The same holds for a first-time RECIPIENT of a shared thread: the
              conversation is materialised empty and the server history lands a
              moment later.

              It leaves as the list arrives, the two overlapping (`popLayout`):
              the skeleton fades on the exit easing while the list fades in over
              it, so the swap is a cross-fade, not a cut. */}
          <AnimatePresence initial={false} mode="popLayout">
            {controller.showSkeleton && (
              <motion.div
                key="skeleton"
                className="flex flex-1 flex-col"
                exit={{ opacity: 0, transition: controller.rowLeave }}
              >
                <MessageListSkeleton />
              </motion.div>
            )}
          </AnimatePresence>
          <ChatMessageList controller={controller} />
        </div>

        {/* The status dock: one quiet line just above the composer, in the gap
            the list always keeps there (its bottom padding is the composer's
            height plus 1.5rem). Out of the thread's flow, so nothing in it moves
            the thread: a colleague at a keyboard (the line used to sit at the
            end of the list and bobbed it by its height every time someone
            started or stopped typing) and the connection's state (the card it
            replaces collapsed out of the thread on reconnect). */}
        <div
          className="pointer-events-none absolute inset-x-0 z-10 mx-auto flex w-full max-w-5xl items-end pr-[max(1rem,env(safe-area-inset-right))] pl-[max(1rem,env(safe-area-inset-left))] sm:pr-[max(1.5rem,env(safe-area-inset-right))] sm:pl-[max(1.5rem,env(safe-area-inset-left))]"
          style={{ bottom: 'calc(var(--composer-h, 11rem) + 0.125rem)' }}
          data-testid="thread-status-dock"
        >
          <AnimatePresence initial={false} mode="popLayout">
            {controller.connectionNote ? (
              <motion.div
                key={controller.connectionNote}
                className="bg-background/85 text-muted-foreground flex h-6 items-center gap-1.5 rounded-control px-2 text-xs"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1, transition: controller.rowEnter }}
                exit={{ opacity: 0, transition: controller.rowLeave }}
              >
                {controller.connectionNote === 'restored' ? (
                  <Check className="text-success size-3.5" aria-hidden="true" />
                ) : (
                  <WifiOff className="size-3.5" aria-hidden="true" />
                )}
                {controller.connectionNote === 'restored'
                  ? controller.t('chatArea.connection.restored')
                  : controller.t('chatArea.connection.lost')}
              </motion.div>
            ) : (
              controller.shared &&
              controller.typists.length > 0 && (
                <motion.div
                  key="typing"
                  className="bg-background/85 rounded-control px-2"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1, transition: controller.rowEnter }}
                  exit={{ opacity: 0, transition: controller.rowLeave }}
                >
                  {/* A colleague at a keyboard. Distinct vocabulary from the
                      agent's banner (see TypingPresence), and independent of it:
                      somebody may well start writing while Piloti is answering. */}
                  <TypingPresence typists={controller.typists} className="py-0" />
                </motion.div>
              )
            )}
          </AnimatePresence>
          {/* Said once per change, politely; mounted for the thread's life so
              a change is announced (a region that mounts with its text is not).
              A live region, not a `status` role: it says nothing about the
              thread's content and must not read as one of its messages. */}
          <span className="sr-only" aria-live="polite" aria-atomic="true">
            {controller.connectionNote === 'restored'
              ? controller.t('chatArea.connection.restored')
              : controller.connectionNote === 'lost'
                ? controller.t('chatArea.connection.lost')
                : ''}
          </span>
        </div>

        {/* Floating "scroll to latest" button — appears when the user has scrolled
          up and newer content is below. Pinned to the wrapper (not the scroll
          content) so it stays put while the thread scrolls behind it. Above the
          status dock while it speaks. On a phone it sits at the trailing edge,
          where a right thumb rests above the composer, 44px; centred it landed on
          the middle of the last line being read. */}
        <AnimatePresence>
          {controller.showScrollButton && (
            <motion.div
              className="pointer-events-none absolute inset-x-0 z-10 flex justify-center max-sm:justify-end max-sm:pr-[max(1rem,env(safe-area-inset-right))] max-sm:pl-[max(1rem,env(safe-area-inset-left))]"
              style={{
                bottom: `calc(var(--composer-h, 11rem) + ${controller.connectionNote || (controller.shared && controller.typists.length > 0) ? '2.25rem' : '1rem'})`,
              }}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              // Leaving one step shorter than it came: the reader pressed it
              // and is already watching the thread move, not the button.
              exit={{
                opacity: 0,
                y: 6,
                transition: controller.prefersReducedMotion ? motionInstant : motionSnap,
              }}
              transition={controller.prefersReducedMotion ? motionInstant : motionQuick}
            >
              <button
                type="button"
                onClick={controller.handleScrollToLatest}
                aria-label={controller.t('chatArea.scrollToLatest')}
                className={cn(
                  PRESSABLE,
                  FOCUS_RING,
                  'bg-card text-muted-foreground hover:text-foreground pointer-events-auto flex size-9 items-center justify-center rounded-control border outline-none pointer-coarse:size-11 shadow-md'
                )}
              >
                <ArrowDown className="size-4" aria-hidden="true" />
              </button>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </MentionPeopleProvider>
  )
})
