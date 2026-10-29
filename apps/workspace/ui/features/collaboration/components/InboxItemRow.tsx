'use client'

/**
 * One inbox row — the generic, registry-driven renderer (spec IB-6).
 *
 * **There is deliberately no `switch (item.type)` in this file for LOOKS.**
 * Every visual decision comes from `INBOX_TYPE_PRESENTATION[item.type]`: which
 * icon to draw, which pair of translation keys to read, and whether the row
 * reads as a request or as an FYI. That is the whole extensibility promise — a
 * new notification type is a registry entry plus two strings, never a new
 * component.
 *
 * The exceptions below are BEHAVIOUR, not looks. A version waiting for a
 * decision carries its three decisions inline, so triage happens here instead
 * of forcing a round-trip through Files. It keys on the actionable document
 * type alone, renders through the same atoms, and resolves server-side — the
 * decision settles the round for every reviewer (`resolveReviewInbox`) and the
 * list re-reads on the `inbox.changed` nudge. Nothing persists on a chat
 * message, so `useCardDecision` does not apply here. A row about a mark (its
 * presentation says `anchor: 'mark'`) opens at the mark, and a request on one
 * (assigned to the reader, Piloti's question, a mention) is answered or
 * resolved right here, through the annotations' own client: the same writes
 * the thread makes, and only where the server's `answerIn` says the reader may.
 * The answer is written in the thread's own composer (`Composer`): Enter sends,
 * „@" mentions whoever may open the document, and @Piloti is offered where
 * events wake Piloti (`pilotiWakes`), as the thread offers it.
 *
 * The row answers **who / what / where / when without being opened** (IB-20):
 * the title carries the actor, the body the subject, the excerpt the actual
 * question, and the timestamp the when (relative, with the exact moment on hover).
 * A row a person caused wears their face, with the type's glyph in its corner;
 * Piloti's rows wear Piloti's.
 *
 * Two behaviours here are security-visible rather than cosmetic:
 *   - An **inert** item (its target was unshared, deleted or purged — IB-13/IB-14)
 *     renders as plain text, never as an anchor. `href` is null for those rows and
 *     an anchor with an empty or `#` href would be a working-looking link to
 *     content the user may no longer reach.
 *   - The **archive** control is a sibling of the row link, not a child of it.
 *     Nesting a button inside an anchor is an accessibility defect and makes the
 *     link's accessible name include the button's.
 */

import type { JSX } from 'react'
import { forwardRef } from 'react'
import Link from 'next/link'
import { usePathname, useSearchParams } from 'next/navigation'
import {
  Archive,
  ArchiveRestore,
  AtSign,
  CheckCircle2,
  Clock,
  HardDrive,
  Layers,
  Mail,
  MailOpen,
  Megaphone,
  MessageSquare,
  MoreHorizontal,
  ShieldAlert,
  UserPlus,
  type LucideIcon,
  AlertTriangle,
  ArrowUpRight,
  Check,
  Reply,
} from 'lucide-react'

import { namespaceRoot, useLocale, useTranslations } from '@/i18n'
import { collaborationCopy } from '@/i18n/namespaces/collaboration'
import { filesCopy } from '@/i18n/namespaces/files'
import { formatAbsoluteTime, formatRelativeTime } from '@/lib/format'
import { inboxItemCopy } from '@/lib/inbox/item-copy'
import {
  INBOX_TYPE_PRESENTATION,
  isMarkAnchored,
  UNKNOWN_TYPE_PRESENTATION,
  type InboxItemView,
  type InboxTypePresentation,
} from '@/lib/inbox/types'
import { ActionMenu, type ActionMenuEntry } from '@/components/ui/action-menu'
import { AttentionDot } from '@/components/ui/attention-dot'
import { Quote } from '@/components/ui/quote'
import { PersonAvatar } from '@/components/ui/avatar-stack'
import { AgentGlyph } from '@/components/ui/agent-glyph'
import { Button } from '@/components/ui/button'
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from '@/components/ui/item'
import { motion, motionQuick } from '@/components/motion'
import { cn } from '@/lib/utils'
import { documentLifecycleClient } from '@/lib/documents/lifecycle-client'
import { DiscussDocumentButton } from '@/features/documents/components/discuss-document-button'
import { projectIdFromDocumentHref } from '@/features/documents/lib/document-question'
import { compareRevisionHref } from '@/features/documents/lib/revision-compare-link'
import { withReviewBack } from '@/features/documents/lib/open-review'
import { Composer } from '@/features/documents/components/review/composer'
import { useFocusBackOnClose } from '@/features/documents/components/review/focus-return'
import { MentionText } from './MentionText'
import { MARK_CLIENT, useMarkAnswer, type InboxMarkClient } from '../hooks/use-mark-answer'
import { InboxItemCaption } from './InboxItemCaption'
import { inboxDue } from '../lib/inbox-due'
import { InboxReviewDecision, type InboxReviewClient } from './InboxReviewDecision'
import { isPlainClick } from '../lib/plain-click'
import { UploadReportLines } from '@/features/uploads/components/upload-report'

/**
 * The ONE place the registry's icon names become components. Keeping the map here
 * (rather than storing components in `lib/inbox/types.ts`) keeps the registry a
 * plain data module that the server half can import without pulling in React.
 * `piloti` is not a Lucide icon but Piloti's own glyph, drawn below.
 */
const ICONS: Record<Exclude<InboxTypePresentation['icon'], 'piloti'>, LucideIcon> =
  {
    'at-sign': AtSign,
    'message-square': MessageSquare,
    'user-plus': UserPlus,
    'check-circle': CheckCircle2,
    'hard-drive': HardDrive,
    'alert-triangle': AlertTriangle,
    clock: Clock,
    layers: Layers,
    megaphone: Megaphone,
    'shield-alert': ShieldAlert,
  }

export type { InboxMarkClient }

export interface InboxItemRowProps {
  item: InboxItemView
  /** Called when the row's link is followed, so the list can mark it read. */
  onOpen?: (item: InboxItemView) => void
  /** Called by the archive button and the menu entry. Omit to hide both. */
  onArchive?: (itemId: string) => void
  /** Takes an archived row back („Wiederherstellen“). Offered only on an archived row. */
  onUnarchive?: (itemId: string) => void
  /** „Als gelesen markieren“ in the row's menu, for an unread row. */
  onMarkRead?: (itemId: string) => void
  /** „Als ungelesen markieren“ in the row's menu, for a read row. */
  onMarkUnread?: (itemId: string) => void
  /** The row the list's keyboard is on (j/k): drawn with a ring, and the one Enter opens. */
  focused?: boolean
  /** The reader, so the excerpt's mention of them is drawn louder, as the thread draws it. */
  viewerId?: string | null
  /** Answering or resolving a mark from the row. Injected by the specs. */
  markClient?: InboxMarkClient
  /**
   * Runs an inline review decision. Injected by the specs; the browser gets
   * the real typed client. Narrowed to the three decisions a reviewer may
   * take — nothing else on this row writes lifecycle state — plus the version
   * read that names the STAND (Fassung number, date) and carries its
   * `contentHash` as the `ifMatch` the decisions send.
   */
  reviewClient?: InboxReviewClient
}

export const InboxItemRow = forwardRef<HTMLLIElement, InboxItemRowProps>(function InboxItemRow(
  {
    item,
    onOpen,
    onArchive,
    onUnarchive,
    onMarkRead,
    onMarkUnread,
    focused = false,
    viewerId = null,
    reviewClient = documentLifecycleClient,
    markClient = MARK_CLIENT,
  },
  ref,
): JSX.Element {
  const t = useTranslations(collaborationCopy)
  const tFiles = useTranslations(filesCopy)
  const { locale } = useLocale()

  /*
    `INBOX_TYPE_PRESENTATION` is exhaustive over `InboxItemType` at COMPILE time,
    and rows come from a `text` column. A row written by a newer deploy — or read
    across a rollback — therefore has a type this map does not know, and indexing
    it produced `undefined.icon`: a TypeError that took down the whole /app/inbox
    route, not just its own row. One unknown row must cost one unremarkable row.
  */
  const presentation = INBOX_TYPE_PRESENTATION[item.type] ?? UNKNOWN_TYPE_PRESENTATION
  const Icon = presentation.icon === 'piloti' ? null : ICONS[presentation.icon]

  /*
    „Besprechen", for a row whose target is a DOCUMENT.

    Still no `switch (item.type)`: the condition is the row's own
    `resourceType`, which every row carries, exactly like `href` and `state`. A
    reviewer reading „Anna bittet um Freigabe von Brandschutzkonzept" has two
    next moves — open the file, or ask about it — and only the first had a
    control. The second used to be impossible anyway: a submitted draft has no
    chunks, so Piloti could not answer about it; the turn now reads the subject
    version's bytes instead.

    The project comes back out of the link the row already holds. The inbox
    payload is deliberately type-agnostic and carries no project field, and
    widening it for one button would put a document's concern into the generic
    shape. An Archiv document has no project chat and correctly yields `null`.
  */
  const documentProjectId =
    item.resourceType === 'document' ? projectIdFromDocumentHref(item.href) : null

  /*
    „Fassungen vergleichen", the next move on a new Fassung filed under another
    name: BEHAVIOUR keyed on the type, like the review triage below. The row
    then names two documents — the newer is the resource, the older the anchor
    — and the link opens the newer one's preview with the comparison against
    the older already open. A same-name version anchors on the version and
    has nothing to lay side by side here; its row opens the document, whose
    Fassungen section compares the text.
  */
  const compareHref =
    item.type === 'document.new_revision' &&
    item.state !== 'inert' &&
    item.resourceType === 'document' &&
    item.related !== null &&
    item.anchorId !== null &&
    item.anchorId !== item.resourceId
      ? compareRevisionHref(item.href, item.anchorId)
      : null

  const inert = item.state === 'inert'
  const unread = item.state === 'unread'
  const resolved = item.state === 'resolved'
  // An operational warning is not a REQUEST: nobody is waiting on the reader, so
  // it is not actionable and it does not resolve. Its body is the news (why it
  // stopped, what was found), so the row keeps it beside a quote.
  const isWarning = presentation.tone === 'warning' && !inert

  // A REDACTED row carries no href and no payload (IB-13); `inboxItemCopy` words it.
  const redacted = !item.href

  const { title, body } = inboxItemCopy(item, t, namespaceRoot(collaborationCopy, locale), locale)
  // The server's own fact: an archived row whose target went away reads
  // `state: 'inert'`, and must still be restored rather than archived again.
  const archived = item.archived

  /*
    A row about a mark (`anchor: 'mark'`): its next move is the mark itself,
    not a chat about the whole document, so „Zur Anmerkung“ leads and „Mit
    Piloti besprechen“ is not offered. The row's resource is the document and
    its anchor the mark, which is all the annotations' client needs.
  */
  const markRow =
    isMarkAnchored(item.type) && !inert && !redacted && item.resourceType === 'document' && item.anchorId !== null
  /*
    The mark opens in Dateien, at the review: closing it comes back here, to
    the Postfach as the reader left it (`back`: this address, which carries
    the list's filter, `InboxList`), not to the bare document.
  */
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const query = searchParams?.toString()
  const here = pathname ? `${pathname}${query ? `?${query}` : ''}` : null
  const linkHref = markRow && item.href ? withReviewBack(item.href, here) : item.href
  const {
    answerHere,
    answerInReview,
    canResolveMark,
    replying,
    setReplying,
    markBusy,
    markOutcome,
    setMarkOutcome,
    untold,
    sendReply,
    resolveMark,
    undoResolve,
    offerUndo,
  } = useMarkAnswer({ item, markRow, markClient, onOpen })
  // Sent or let go, the answer box goes and „Antworten“ comes back: the focus goes with it.
  const replyButtonRef = useFocusBackOnClose<HTMLButtonElement>(answerHere && replying && item.anchorId !== null)
  // „Erledigen“ goes when it is pressed and „Rückgängig“ takes its place, and back
  // again: the focus follows the control that took the place of the pressed one.
  // When the window ends with the write, „Rückgängig“ goes and „Erledigen“ does
  // not come back: the focus goes to the outcome line, which stays („Als
  // erledigt markiert.“). Whichever of the two is drawn takes it, the other's
  // ref is empty.
  const undoRef = useFocusBackOnClose<HTMLButtonElement>(!offerUndo)
  const resolveRef = useFocusBackOnClose<HTMLButtonElement>(offerUndo)
  const outcomeRef = useFocusBackOnClose<HTMLParagraphElement>(offerUndo)

  /*
    The row's own menu: first what the row asks of the reader (answer, resolve,
    compare), which on a touch screen lives only here, then the read state,
    archive (the only archive control on a phone) and restore.
  */
  const settled = replying || markOutcome === 'resolved'
  const menuEntries: ActionMenuEntry[] = [
    ...(answerHere && !settled
      ? [{ type: 'item' as const, id: 'reply', label: t('inbox.mark.reply'), icon: MessageSquare, onSelect: () => { setMarkOutcome(null); setReplying(true) }, testId: 'inbox-mark-reply-menu' }]
      : []),
    ...(canResolveMark && !settled
      ? [{ type: 'item' as const, id: 'resolve', label: t('inbox.mark.resolve'), icon: CheckCircle2, onSelect: resolveMark, testId: 'inbox-mark-resolve-menu' }]
      : []),
    ...(answerInReview && linkHref
      ? [{ type: 'item' as const, id: 'review', label: t('inbox.mark.answerInReview'), icon: MessageSquare, href: linkHref, onSelect: () => onOpen?.(item) }]
      : []),
    ...(compareHref
      ? [{ type: 'item' as const, id: 'compare', label: t('inbox.compareRevisions'), icon: Layers, href: compareHref, onSelect: () => onOpen?.(item) }]
      : []),
    ...(answerHere || canResolveMark || answerInReview || compareHref ? [{ type: 'separator' as const }] : []),
    ...(item.state === 'unread' && onMarkRead
      ? [{ type: 'item' as const, id: 'read', label: t('inbox.markRead'), icon: MailOpen, onSelect: () => onMarkRead(item.id), testId: 'inbox-mark-read' }]
      : []),
    ...(item.state === 'read' && onMarkUnread
      ? [{ type: 'item' as const, id: 'unread', label: t('inbox.markUnread'), icon: Mail, onSelect: () => onMarkUnread(item.id), testId: 'inbox-mark-unread' }]
      : []),
    ...(archived && onUnarchive
      ? [{ type: 'item' as const, id: 'unarchive', label: t('inbox.unarchive'), icon: ArchiveRestore, onSelect: () => onUnarchive(item.id), testId: 'inbox-unarchive' }]
      : []),
    ...(!archived && onArchive
      ? [{ type: 'item' as const, id: 'archive', label: t('inbox.archive'), icon: Archive, onSelect: () => onArchive(item.id), testId: 'inbox-archive-menu' }]
      : []),
  ]

  // Who caused it, when a person did: their face, with the type's glyph in the
  // corner. Piloti's rows keep Piloti's face; a system row keeps its glyph.
  const actorFace =
    presentation.icon !== 'piloti' && item.actorUserId && item.actorName
      ? { userId: item.actorUserId, name: item.actorName }
      : null

  /*
    Inline triage for a version waiting for a decision (ADR-0054): the three
    decisions on the row, so the reviewer answers here instead of navigating
    to Files first. Offered only while the round is still open for this
    reader — actionable, unresolved, reachable, naming its version AND its
    Fassung (the subject is required: without it the confirm could not name
    which document the signature releases). The server enforces who may decide
    (project:edit, never the submitter); a refusal there surfaces as an error
    line, never as a silent nothing.
  */
  const canDecideReview =
    item.type === 'document.review_requested' &&
    item.actionable &&
    !resolved &&
    !inert &&
    item.resourceType === 'document' &&
    item.anchorId !== null &&
    item.subject !== null
  /*
    The body line says what the row's next move is („Antworten Sie im Verlauf
    oder erledigen Sie die Anmerkung“): the words the push notification needs,
    which has no buttons. A row that draws those moves as its own controls says
    it twice, and every request read as three lines of instructions above the
    buttons they describe (design language, principle 9). There the controls
    are the sentence.
  */
  /*
    And beside a quote, the body was a third paragraph between the title and
    the words the row is about. It stays where it is the news: a row with no
    quote, a warning (why Piloti stopped, what the content check found), and
    a redacted row, whose body says why it is empty.
  */
  const showBody =
    body !== null && !answerHere && !answerInReview && !canDecideReview && (!item.excerpt || isWarning || redacted)
  /** The chat a row happened in, where its title does not name it: on the caption line, beside the project. */
  const chatName = item.subject ?? t('inbox.untitledConversation')
  // Named once per row: not where the title or the body already says it. Piloti's own rows about a chat
  // (a proposal) carry no chat name by design: no „Unbenannter Chat“ for them.
  const place =
    item.resourceType === 'conversation' &&
    presentation.icon !== 'piloti' &&
    !redacted &&
    !title.includes(chatName) &&
    !(showBody && body?.includes(chatName))
      ? chatName
      : null
  /** What a new Fassung leaves to check, where its sentence gave way to the quote: a fact on the caption line. */
  const openMarks = item.type === 'document.new_revision' && !inert && !showBody ? (item.openMarks ?? 0) : 0
  const dueChip = inboxDue(item, t, locale)
  return (
    /* The row owns its own <li>, so it is the element that animates — wrapping it
       from the list would nest <li> in <li>, and a `display: contents` wrapper has
       no box for a transform to act on. Exit + layout so archiving closes the gap
       rather than snapping it shut; `AnimatePresence` lives in InboxList. */
    <Item
      asChild
      className={cn(
        'group/row relative items-start gap-3 py-3 pl-7 pr-4',
        /*
          One state for "the row you are on", whoever put you there: the
          pointer, the keyboard (j/k) or the focus. An opaque surface step, so
          the toolbar that comes up over its corner sits on the same ground.
          It used to be a translucent tint plus an inset ring on top of the
          Item's own focus ring, which drew a double black bar against the
          dividers and read as a rendering fault.
        */
        'hover:bg-muted focus-visible:bg-muted focus-visible:ring-0',
        // The keyboard's own indicator is the app's focus outline (3:1, WCAG
        // 2.4.11), drawn inside the row's rounded edge (`data-focus-inset`).
        'rounded-control',
        inert && 'bg-muted/60',
        focused && 'bg-muted',
      )}
    >
      <motion.li
        ref={ref}
        layout
        exit={{ opacity: 0, x: 12 }}
        transition={motionQuick}
        data-testid="inbox-item"
        data-item-id={item.id}
        data-state={item.state}
        data-type={item.type}
        data-focused={focused || undefined}
        data-focus-inset=""
        tabIndex={-1}
      >
        {/* Unread: the attention dot in the row's own gutter, on the title's
            first line, rather than a bar down the edge (side stripes are
            discouraged, design-language.md). It no longer touches the avatar:
            the ring it wore merged the two into one smudge. */}
        <AttentionDot show={unread} className="absolute left-3 top-[1.1rem] size-2 ring-0" />
        {/* Who it is from, in one material: a person's face, Piloti's glyph,
            or the type's glyph for a system row, all on the same neutral
            ground. The tinted wells and the glyph badges in the avatars'
            corners made a rainbow of small marks down the list; what a row
            asks and how urgent it is are said in words on its lines. */}
        <ItemMedia aria-hidden className={cn('mt-0.5 size-8', inert && 'opacity-60')}>
          {actorFace ? (
            <PersonAvatar person={actorFace} size="md" />
          ) : Icon ? (
            <span className="flex size-8 items-center justify-center rounded-full bg-muted text-muted-foreground">
              <Icon className="size-4" />
            </span>
          ) : (
            <AgentGlyph size="lg" tone="outline" />
          )}
        </ItemMedia>

        <ItemContent className={cn(inert && 'opacity-90')}>
          {/* What happened, and when at the line's end: where every mail
              client puts it, so the eye goes there without being told. The
              toolbar comes up over it on the row you are on. */}
          <div className="flex items-baseline gap-3">
          <ItemTitle
            className={cn(
              // overflow-visible: `truncate` on ItemTitle would clip the
              // stretched-link overlay to the title box. The clamp is on the
              // words instead: one line where there is room, two on a phone.
              'min-w-0 flex-1 overflow-visible whitespace-normal',
              unread ? 'font-semibold' : 'font-normal',
            )}
          >
            {item.href && !inert ? (
              // Stretched link: the whole row is the target without nesting the
              // archive button inside the anchor (that button is lifted above the
              // overlay with `z-10`).
              <Link
                href={linkHref ?? item.href}
                // Only a plain primary click counts as "opened". Cmd/ctrl/middle
                // click is the natural triage gesture — open three rows in
                // background tabs — and it used to spend the read state of all
                // three and, under the "needs me" filter, delete them from under
                // the cursor while the user was still clicking.
                onClick={(event) => {
                  if (isPlainClick(event)) onOpen?.(item)
                }}
                onAuxClick={(event) => event.stopPropagation()}
                data-testid="inbox-item-link"
                className={cn(
                  'line-clamp-2 min-w-0 rounded-sm leading-snug outline-none sm:line-clamp-1',
                  'after:absolute after:inset-0 after:content-[""]',
                  'focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50',
                  // A read row steps back in dark mode, where weight alone did
                  // not tell the two apart.
                  unread ? 'font-semibold text-foreground' : 'text-foreground dark:text-muted-foreground',
                )}
              >
                {title}
              </Link>
            ) : (
              <span
                className={cn(
                  'line-clamp-2 min-w-0 leading-snug sm:line-clamp-1',
                  unread ? 'font-semibold text-foreground' : 'text-foreground dark:text-muted-foreground',
                )}
              >
                {title}
              </span>
            )}
          </ItemTitle>
            {/* `updatedAt`, which is what the list is ORDERED by. A grouped row
                that just absorbed a new message sorts to the top, and showing its
                `createdAt` put "5 days ago" at the head of the list. The title
                carries the absolute moment for both. */}
            <time
              className={cn(
                // Beside the title where there is room; a phone's title needs
                // the width, and there the moment heads the caption line.
                'shrink-0 text-xs tabular-nums text-muted-foreground max-sm:hidden',
                // Under the toolbar on the row you are on: a narrower toolbar
                // left the moment's first letters peeking out beside it.
                'pointer-fine:group-hover/row:invisible pointer-fine:group-focus-within/row:invisible',
                focused && 'pointer-fine:invisible',
              )}
              dateTime={item.updatedAt}
              title={formatAbsoluteTime(item.updatedAt, locale)}
            >
              {formatRelativeTime(item.updatedAt, locale)}
            </time>
          </div>

          {/* Where and when, under the title and before anything else: the
              project first (an office runs several, and „Grundriss EG“ alone
              does not say whose), then the moment, then by when. One caption
              line, so the eye finds it at the same place on every row. */}
          <InboxItemCaption
            item={item}
            place={place}
            openMarks={openMarks}
            due={dueChip}
            answered={resolved && item.actionable}
          />

          {/* Two lines, not one: the body is where a row says what to do, and one
              truncated line cut that sentence off in its middle. */}
          {showBody && <ItemDescription className="mt-1 line-clamp-2 whitespace-normal">{body}</ItemDescription>}

          {/* Two lines when it is the row's only body (what a colleague
              asked, what changed): one cut the sentence in its middle. One
              line under a body, which already said what the row is. */}
          {item.excerpt && (
            <Quote
              as="p"
              className={cn(
                // On the title's own edge, upright and in the secondary ink: a
                // preview, as a mail client shows the first words of a mail.
                // Italic on every row was texture, not emphasis.
                'mt-0.5 ps-0 text-sm not-italic leading-snug text-muted-foreground',
                // Dense on a phone: three rows to a screen is a list nobody can
                // triage. A row that asks something of the reader keeps its
                // words; an FYI gets one line, and the item has the rest.
                // As the ONLY body it is the news and keeps three lines.
                showBody ? 'line-clamp-1' : 'line-clamp-2',
              )}
              data-testid="inbox-item-excerpt"
            >
              {/* The quote's mentions as the thread's chips (`MentionText`):
                  only the ones the server kept, so a name typed by hand stays
                  text. One paragraph, as in any clamp. */}
              <MentionText
                content={item.excerpt}
                mentions={item.mentions}
                currentUserId={viewerId}
                className="whitespace-normal"
              />
            </Quote>
          )}

          {/* A completed project upload's Eingangsbericht: what it brought the
              project. Keyed on the data, as `href` is: only such a row carries one. */}
          {item.uploadReport && !inert && <UploadReportLines report={item.uploadReport} />}

          {/* The excerpt above is the order once the submit request carries
              one; the open link below is the file behind the decision. A real
              diff needs the previous version, which the payload does not name
              — so triage opens the file, it does not pretend to compare. */}
          {canDecideReview && <InboxReviewDecision item={item} reviewClient={reviewClient} onOpen={onOpen} />}

          {answerHere && replying && item.anchorId && (
            <div className="relative z-10 mt-2 space-y-1.5" data-testid="inbox-mark-reply-form">
              <Composer
                autoFocus
                testId="inbox-mark-reply-box"
                placeholder={
                  item.related ? t('inbox.mark.replyLabel', { related: item.related }) : t('inbox.mark.replyLabelNoNumber')
                }
                submitLabel={t('inbox.mark.send')}
                documentId={item.resourceId}
                mentionAgent={item.pilotiWakes === true}
                describeFailure={() => t('inbox.mark.failed')}
                onSubmit={sendReply}
                onEscape={() => setReplying(false)}
              />
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-7 text-xs"
                data-testid="inbox-mark-reply-cancel"
                onClick={() => setReplying(false)}
              >
                {t('inbox.mark.cancel')}
              </Button>
            </div>
          )}
          {markOutcome && (
            <p
              ref={outcomeRef}
              tabIndex={-1}
              role={markOutcome === 'failed' || markOutcome === 'conflict' ? 'alert' : 'status'}
              className={cn(
                'mt-1.5 text-xs',
                markOutcome === 'failed' || markOutcome === 'conflict' ? 'text-error' : 'text-muted-foreground',
              )}
              data-testid="inbox-mark-outcome"
            >
              {t(`inbox.mark.${markOutcome}`)}
              {offerUndo && (
                <>
                  {' '}
                  <Button
                    ref={undoRef}
                    type="button"
                    variant="inline"
                    className="relative z-10"
                    disabled={markBusy}
                    data-testid="inbox-mark-undo"
                    onClick={undoResolve}
                  >
                    {t('inbox.undo')}
                  </Button>
                </>
              )}
              {markOutcome !== 'failed' && markOutcome !== 'conflict' && untold.length > 0 && (
                <>
                  {' '}
                  {untold.length === 1
                    ? tFiles('review.mentions.untoldOne', { name: untold[0] })
                    : tFiles('review.mentions.untoldMany', { names: untold.join(', ') })}
                </>
              )}
            </p>
          )}
        </ItemContent>

        {/* Drawn whenever the row has anything to offer, not only an archive:
            a row rendered without the list's handlers still has its own moves. */}
        {(menuEntries.length > 0 || (onArchive && !archived) || compareHref !== null || answerInReview || (documentProjectId !== null && !inert && !markRow)) && (
          <ItemActions
            data-testid="inbox-item-toolbar"
            className={cn(
              'gap-1 transition-opacity duration-snap motion-reduce:transition-none',
              /*
                A row at rest says who, what, where and when; what can be done
                with it comes up on the row the pointer, the focus or the
                keyboard (j/k) is on, as one small toolbar over the row's top
                corner. Drawn on every row, the buttons made a list of eight
                requests sixteen buttons and twenty-four icons: the loudest
                pattern on the page, and identical on every row. Floating, it
                moves nothing when it comes.

                Touch has no hover (design language, Touch): there the toolbar
                is the row's „…“ menu in its own column, and the menu carries
                every action the toolbar has.
              */
              // On the row's own ground (the hover surface), over the moment at
              // the title line's end, as a mail client swaps the date for its
              // actions: no box of its own to collide with the title.
              'pointer-fine:absolute pointer-fine:right-2 pointer-fine:top-1.5 pointer-fine:z-10 pointer-fine:gap-0.5',
              'pointer-fine:rounded-control pointer-fine:bg-muted pointer-fine:pl-2',
              !focused &&
                'pointer-fine:pointer-events-none pointer-fine:opacity-0 pointer-fine:group-hover/row:pointer-events-auto pointer-fine:group-hover/row:opacity-100 pointer-fine:group-focus-within/row:pointer-events-auto pointer-fine:group-focus-within/row:opacity-100',
            )}
          >
            {/* z-10, like the archive control: the row's stretched link paints an
                overlay across the whole card, and anything meant to be clickable
                has to sit above it. Never on an inert row — its target is gone,
                which is the same reason the title is not a link there. */}
            {compareHref && (
              <Button asChild variant="ghost" size="icon" className="relative z-10 size-8 text-muted-foreground hover:text-foreground pointer-coarse:hidden">
                <Link
                  href={compareHref}
                  title={t('inbox.compareRevisions')}
                  aria-label={t('inbox.compareRevisionsLabel', { subject: item.subject ?? t(redacted ? 'inbox.inert' : 'inbox.untitledConversation') })}
                  onClick={(event) => {
                    if (isPlainClick(event)) onOpen?.(item)
                  }}
                  data-testid="inbox-compare-revisions"
                >
                  <Layers aria-hidden />
                  <span className="sr-only">{t('inbox.compareRevisions')}</span>
                </Link>
              </Button>
            )}
            {/* The row itself opens the mark (its stretched link), so a button
                saying „Zur Anmerkung“ was the row's own click drawn a second
                time, in ink, on every row about a mark. It stays where it IS
                the action: Piloti's question answered in the Prüfansicht. */}
            {answerInReview && item.href && (
              <Button asChild variant="ghost" size="icon" className="relative z-10 size-8 text-muted-foreground hover:text-foreground pointer-coarse:hidden">
                <Link
                  href={linkHref ?? item.href}
                  title={t('inbox.mark.answerInReview')}
                  onClick={(event) => {
                    if (isPlainClick(event)) onOpen?.(item)
                  }}
                  data-testid="inbox-open-mark"
                >
                  <ArrowUpRight aria-hidden />
                  <span className="sr-only">{t('inbox.mark.answerInReview')}</span>
                </Link>
              </Button>
            )}
            {answerHere && !settled && (
              <Button
                ref={replyButtonRef}
                type="button"
                size="icon"
                variant="ghost"
                className="relative z-10 size-8 text-muted-foreground hover:text-foreground pointer-coarse:hidden"
                title={t('inbox.mark.reply')}
                disabled={markBusy}
                data-testid="inbox-mark-reply"
                onClick={() => {
                  setMarkOutcome(null)
                  setReplying(true)
                }}
              >
                <Reply aria-hidden />
                <span className="sr-only">{t('inbox.mark.reply')}</span>
              </Button>
            )}
            {canResolveMark && !settled && (
              <Button
                ref={resolveRef}
                type="button"
                size="icon"
                variant="ghost"
                className="relative z-10 size-8 text-muted-foreground hover:text-foreground pointer-coarse:hidden"
                title={t('inbox.mark.resolve')}
                disabled={markBusy}
                data-testid="inbox-mark-resolve"
                onClick={resolveMark}
              >
                <Check aria-hidden />
                <span className="sr-only">{t('inbox.mark.resolve')}</span>
              </Button>
            )}
            {documentProjectId && !inert && !markRow && (
              <DiscussDocumentButton
                projectId={documentProjectId}
                documentId={item.resourceId}
                variant="ghost"
                iconOnly
                onNavigate={() => onOpen?.(item)}
                className="relative z-10 text-muted-foreground hover:text-foreground"
              />
            )}
            {/* z-10 keeps these above the stretched link's overlay so they stay
                clickable; they are siblings of the anchor, never children. The
                archive icon is a desktop affordance: on a phone its column cost
                the title its width, and the menu carries archiving there. */}
            {onArchive && !archived && (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="relative z-10 size-8 text-muted-foreground hover:text-foreground pointer-coarse:hidden"
                aria-label={t('inbox.archive')}
                title={t('inbox.archive')}
                onClick={() => onArchive(item.id)}
              >
                <Archive className="size-4" aria-hidden />
              </Button>
            )}
            <ActionMenu
              mode="dropdown"
              entries={menuEntries}
              trigger={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="relative z-10 size-8 text-muted-foreground touch-target"
                  aria-label={t('inbox.moreActions')}
                  data-testid="inbox-item-menu"
                >
                  <MoreHorizontal className="size-4" aria-hidden />
                </Button>
              }
            />
          </ItemActions>
        )}
      </motion.li>
    </Item>
  )
})
