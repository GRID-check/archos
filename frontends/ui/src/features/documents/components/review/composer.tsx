'use client'

import { useCallback, useEffect, useMemo, useRef, useState, type JSX, type KeyboardEvent } from 'react'
import { ArrowUp, Sparkles } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { FieldError } from '@/components/ui/field'
import {
  MentionPicker,
  type MentionPickerAria,
  type MentionPickerHandle,
} from '@/features/collaboration/components/MentionPicker'
import {
  findMentionQuery,
  insertMention,
  reconcileMentions,
  splitMentionSegments,
  type DraftMention,
  type MentionQuery,
} from '@/features/collaboration/lib/mention-text'
import { useTranslations } from '@/i18n'
import { AnnotationRequestError } from '@/lib/annotations/client'
import { MAX_ANNOTATION_BODY, type MarkMention } from '@/lib/annotations/types'
import { MAX_MENTIONS_PER_MESSAGE } from '@/lib/limits/catalog'
import { AGENT_MENTION_ID, MENTION_ERROR_REASONS, type MentionCandidate } from '@/lib/mentions/types'
import { cn } from '@/lib/utils'
import { useMentionablePeople } from '../../hooks/use-mentionable-people'

/** What a send carries beside its words: whom the person picked, and whether Piloti is among them. */
export interface ComposerSend {
  piloti: boolean
  mentions: MarkMention[]
}

/** The text with every token of one mention taken out, and the space after it. */
function withoutMention(text: string, mentions: readonly DraftMention[], targetId: string): string {
  const segments = splitMentionSegments(text, mentions)
  let out = ''
  let dropSpace = false
  for (const segment of segments) {
    if (segment.kind === 'mention' && segment.targetId === targetId) {
      dropSpace = true
      continue
    }
    out += dropSpace ? segment.text.replace(/^ /, '') : segment.text
    dropSpace = false
  }
  return out
}

/**
 * The reply box and the draft box: Enter sends, Shift+Enter breaks the line,
 * Escape lets go.
 *
 * `onAskPiloti`: a second way out, the text handed to Piloti instead
 * (⌘/Ctrl+Enter, or the spark beside Send).
 *
 * Mentions are the chat's, gesture for gesture: „@" opens the chat's own
 * picker (`MentionPicker`), and a pick writes „@Name" into the text and
 * records whom it means (`features/collaboration/lib/mention-text.ts`). What
 * is sent is reconciled against the text at the last moment, so a name
 * deleted while editing is nobody mentioned, and a name typed by hand never
 * was. `mentionPiloti` offers Piloti (the spark beside Send writes its
 * mention too); `documentId` offers everyone who may open that document. The
 * server keeps a mention only for someone who may open it; `onSubmit` answers
 * with the mentions it kept, and the box says whom it did not tell.
 *
 * One box for every place a person writes into a thread: the thread's reply,
 * the draft, the author rewording a mark or a reply, and the answer from a
 * Postfach row (`features/collaboration/components/InboxItemRow.tsx`).
 */
export function Composer({
  placeholder,
  submitLabel,
  autoFocus,
  onSubmit,
  onEscape,
  onAskPiloti,
  mentionPiloti,
  documentId,
  pickerSide = 'below',
  maxLength = MAX_ANNOTATION_BODY,
  initialBody = '',
  initialMentions,
  describeFailure,
  testId,
}: {
  placeholder: string
  submitLabel: string
  autoFocus?: boolean
  /** Sends; answers with the mentions the server kept, where it says. */
  onSubmit: (body: string, options: ComposerSend) => Promise<readonly MarkMention[] | void>
  onEscape?: () => void
  onAskPiloti?: (body: string) => void
  mentionPiloti?: boolean
  /** The document whose readers may be mentioned; absent, nobody is offered. */
  documentId?: string
  /** Where the picker opens: under a box at the top of its card, over one at its foot. */
  pickerSide?: 'above' | 'below'
  maxLength?: number
  /** The text to start from: a mark's own words, when its author rewords it. */
  initialBody?: string
  /** Whom `initialBody` mentions, as the server kept them: they stay mentioned while their name stands. */
  initialMentions?: readonly MarkMention[]
  /**
   * The caller's words for a send `onSubmit` threw on, where it has them (a
   * reply Piloti took up meanwhile, the Postfach row's own failure); null
   * leaves the box's own: the chat's words for a spent mention budget, else
   * that it was not sent. The text stays either way.
   */
  describeFailure?: (error: unknown) => string | null
  testId: string
}): JSX.Element {
  const t = useTranslations('files')
  const tCollab = useTranslations('collaboration')
  const agentName = tCollab('mentions.picker.agentName')
  const [body, setBody] = useState(initialBody)
  const [busy, setBusy] = useState(false)
  /** Why the last send did not go: the chat's words for a spent mention budget, the bound for too many names, else a plain failure. */
  const [failed, setFailed] = useState<string | null>(null)
  /** Whom the person picked, as the chat's composer records it: never read out of the text. */
  // A reworded mark starts with whom it mentions, pruned to the names that stand in its text.
  const [picked, setPicked] = useState<DraftMention[]>(() => reconcileMentions(initialBody, [...(initialMentions ?? [])]))
  const [query, setQuery] = useState<MentionQuery | null>(null)
  const [dismissed, setDismissed] = useState(false)
  /** Counted up on each new „@", so a list that failed to load is asked for again. */
  const [attempt, setAttempt] = useState(0)
  const [aria, setAria] = useState<MentionPickerAria>({ listboxId: null, activeOptionId: null })
  /** The names the server did not keep on the last send: they cannot open the document. */
  const [untold, setUntold] = useState<string[]>([])
  const ref = useRef<HTMLTextAreaElement | null>(null)
  const pickerRef = useRef<MentionPickerHandle>(null)
  // Text to start from is edited from its end, as a reworded mark is.
  const pendingCaret = useRef<number | null>(autoFocus && initialBody ? initialBody.length : null)
  const { people, loading, failed: peopleFailed } = useMentionablePeople(documentId ?? null, attempt)
  const mentionsOn = Boolean(mentionPiloti || documentId)

  useEffect(() => {
    if (autoFocus) ref.current?.focus()
  }, [autoFocus])

  // Grow with the text, up to a handful of lines, then scroll; and put the
  // caret after a name the picker just wrote.
  useEffect(() => {
    const node = ref.current
    if (!node) return
    node.style.height = '0px'
    node.style.height = `${Math.min(node.scrollHeight, 144)}px`
    const caret = pendingCaret.current
    if (caret === null) return
    pendingCaret.current = null
    node.focus()
    node.setSelectionRange(caret, caret)
  }, [body])

  const candidates = useMemo<MentionCandidate[]>(
    () => [
      ...(mentionPiloti
        ? [
            {
              targetId: AGENT_MENTION_ID,
              person: { userId: AGENT_MENTION_ID, name: agentName, email: null, profilePictureUrl: null },
              isAgent: true,
              isParticipant: true,
              needsInvite: false,
            },
          ]
        : []),
      // Everyone here may open the document, which is the only roster a mark has.
      ...people.map((person) => ({
        targetId: person.userId,
        person,
        isAgent: false,
        isParticipant: false,
        needsInvite: false,
      })),
    ],
    [mentionPiloti, agentName, people]
  )
  const standing = useMemo(() => reconcileMentions(body, picked), [body, picked])
  const pilotiMentioned = standing.some((mention) => mention.targetId === AGENT_MENTION_ID)
  const pickerOpen = mentionsOn && query !== null && !dismissed

  const syncQuery = (text: string, caret: number | null) => {
    if (!mentionsOn) return
    const next = caret === null ? null : findMentionQuery(text, caret)
    // A fresh „@" (not one more letter after it) asks for the people again if
    // the last read failed; a loaded list is not read twice.
    if (next && (!query || query.start !== next.start)) setAttempt((count) => count + 1)
    setQuery(next)
    if (!next) setDismissed(false)
  }

  const change = (text: string, caret: number | null) => {
    setBody(text)
    // A name taken out of the text is a pick taken back: it can never decide
    // whom a later namesake's token means (`reconcileMentions`).
    setPicked((current) => reconcileMentions(text, current))
    setUntold([])
    syncQuery(text, caret)
  }

  const select = useCallback(
    (candidate: MentionCandidate) => {
      if (!query) return
      const display = candidate.isAgent ? agentName : candidate.person.name
      const next = insertMention(body, query, display)
      pendingCaret.current = next.caret
      setBody(next.text)
      setPicked((current) => [...current, { targetId: candidate.targetId, display }])
      setQuery(null)
      setDismissed(false)
    },
    [agentName, body, query]
  )

  /** The spark: Piloti's mention written at the start, or taken out again. */
  const togglePiloti = () => {
    if (pilotiMentioned) {
      const text = withoutMention(body, picked, AGENT_MENTION_ID)
      setBody(text)
      setPicked((current) => reconcileMentions(text, current))
    } else {
      const token = `@${agentName} `
      pendingCaret.current = token.length + body.length
      setBody(`${token}${body}`)
      setPicked((current) => [...current, { targetId: AGENT_MENTION_ID, display: agentName }])
    }
    ref.current?.focus()
  }

  const submit = async () => {
    const text = body.trim()
    if (!text || busy) return
    const sent = reconcileMentions(text, picked)
    const mentions = [...new Map(sent.map((mention) => [mention.targetId, mention])).values()]
    // The server's bound, said before the send rather than as a refusal after it.
    if (mentions.length > MAX_MENTIONS_PER_MESSAGE) {
      setFailed(t('review.mentions.tooMany', { max: MAX_MENTIONS_PER_MESSAGE }))
      return
    }
    setBusy(true)
    setFailed(null)
    try {
      const kept = await onSubmit(body, {
        piloti: sent.some((mention) => mention.targetId === AGENT_MENTION_ID),
        mentions,
      })
      setBody('')
      setPicked([])
      setQuery(null)
      // A colleague the server did not keep could not open the document: the box says so, once.
      const keptIds = kept ? new Set(kept.map((mention) => mention.targetId)) : null
      setUntold(
        keptIds
          ? mentions
              .filter((mention) => mention.targetId !== AGENT_MENTION_ID && !keptIds.has(mention.targetId))
              .map((mention) => mention.display)
          : []
      )
    } catch (error) {
      const rateLimited = error instanceof AnnotationRequestError && error.reason === MENTION_ERROR_REASONS.rateLimited
      setFailed(
        rateLimited
          ? tCollab('mentions.errors.rateLimited')
          : (describeFailure?.(error) ?? t('review.sendFailed'))
      )
    } finally {
      setBusy(false)
    }
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return
    // While the picker is open it owns the navigation keys, and Enter inserts:
    // a reply sent because someone confirmed a name is the worst outcome here.
    if (pickerOpen) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        pickerRef.current?.move(event.key === 'ArrowDown' ? 1 : -1)
        return
      }
      if (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey)) {
        event.preventDefault()
        if (pickerRef.current?.selectActive()) return
        setDismissed(true)
        if (event.key === 'Enter') void submit()
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        setDismissed(true)
        return
      }
    }
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && onAskPiloti) {
      event.preventDefault()
      onAskPiloti(body.trim())
      return
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      void submit()
    }
    if (event.key === 'Escape' && onEscape) {
      event.stopPropagation()
      onEscape()
    }
  }

  const pilotiButton = onAskPiloti ? (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className="size-6 shrink-0 rounded-full [&_svg]:size-3.5"
      aria-label={t('review.piloti.ask')}
      title={`${t('review.piloti.ask')} (⌘↵)`}
      data-testid={`${testId}-piloti`}
      onClick={() => onAskPiloti(body.trim())}
    >
      <Sparkles aria-hidden />
    </Button>
  ) : mentionPiloti ? (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className={cn('size-6 shrink-0 rounded-full [&_svg]:size-3.5', pilotiMentioned && 'bg-accent text-foreground')}
      aria-label={t('review.piloti.mention')}
      aria-pressed={pilotiMentioned}
      title={t('review.piloti.mentionHint')}
      data-testid={`${testId}-mention`}
      onClick={togglePiloti}
    >
      <Sparkles aria-hidden />
    </Button>
  ) : null

  return (
    <div className="relative">
      <div className="bg-input-background focus-within:border-foreground/40 rounded-lg border px-2.5 py-1.5 transition-colors duration-quick ease-out">
        <div className="flex items-end gap-1.5">
          <textarea
            ref={ref}
            data-testid={testId}
            aria-label={placeholder}
            // Combobox semantics only while the picker is live, as the chat's
            // composer: the listbox `aria-controls` names exists only then.
            role={pickerOpen ? 'combobox' : undefined}
            aria-autocomplete={pickerOpen ? 'list' : undefined}
            aria-expanded={pickerOpen ? true : undefined}
            aria-haspopup={pickerOpen ? 'listbox' : undefined}
            aria-controls={pickerOpen ? (aria.listboxId ?? undefined) : undefined}
            aria-activedescendant={pickerOpen ? (aria.activeOptionId ?? undefined) : undefined}
            rows={1}
            value={body}
            maxLength={maxLength}
            placeholder={placeholder}
            onChange={(event) => change(event.target.value, event.target.selectionStart)}
            onSelect={(event) => syncQuery(event.currentTarget.value, event.currentTarget.selectionStart)}
            onBlur={() => setQuery(null)}
            onKeyDown={onKeyDown}
            // Enter sends (`onKeyDown`), so the phone's action key says so
            // rather than drawing the return glyph over a key that sends half a
            // sentence, as the chat's composer does (`InputArea`).
            enterKeyHint="send"
            // 16px on a coarse pointer, as the field atoms (`input.tsx`): under it
            // iOS zooms the page on focus and does not zoom back out.
            className="placeholder:text-muted-foreground min-h-6 flex-1 resize-none border-0 bg-transparent py-0.5 text-[13px] leading-5 shadow-none outline-none! ring-0 focus-visible:ring-0 pointer-coarse:text-base"
          />
          {pilotiButton}
          <Button
            type="button"
            size="icon"
            // 24px under a mouse; under a finger a 32px disc with the 44px
            // catchment the touch floor asks for (`touch-target`), instead of
            // the atom's `min-w-11`, which stretched the 24px disc into an oval.
            className="touch-target size-6 shrink-0 rounded-full pointer-coarse:size-8 pointer-coarse:min-w-0 [&_svg]:size-3.5 pointer-coarse:[&_svg]:size-4"
            disabled={!body.trim() || busy}
            aria-label={submitLabel}
            title={`${submitLabel} (Enter)`}
            data-testid={`${testId}-send`}
            // A press on Send keeps the focus in the box: the click still
            // arrives, the caret stays for the next line, and on a phone the
            // keyboard stays up instead of dropping after every message (the
            // button disables itself once the box is empty, which would leave
            // the focus on <body>).
            onPointerDown={(event) => event.preventDefault()}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => void submit()}
          >
            <ArrowUp aria-hidden />
          </Button>
        </div>
      </div>
      {pickerOpen && (
        // A press on a row must not take the focus from the box: the row's
        // click still arrives, and the caret stays where the name goes.
        <div
          className={cn('absolute inset-x-0 z-20', pickerSide === 'above' ? 'bottom-full mb-1' : 'top-full mt-1')}
          onPointerDown={(event) => event.preventDefault()}
          onMouseDown={(event) => event.preventDefault()}
        >
          <MentionPicker
            ref={pickerRef}
            query={query?.query ?? ''}
            candidates={candidates}
            canInvite={false}
            loading={loading && candidates.length === 0}
            onSelect={select}
            onAriaChange={setAria}
            othersHeading={t('review.mentions.othersHeading')}
            noResultsHint={t('review.mentions.noResultsHint')}
            notice={peopleFailed ? t('review.mentions.peopleFailed') : undefined}
            className="max-h-64"
          />
        </div>
      )}
      {untold.length > 0 && (
        <p className="text-muted-foreground mt-1 text-[11px] leading-4" role="status" data-testid={`${testId}-untold`}>
          {untold.length === 1
            ? t('review.mentions.untoldOne', { name: untold[0] })
            : t('review.mentions.untoldMany', { names: untold.join(', ') })}
        </p>
      )}
      {failed && <FieldError className="mt-1">{failed}</FieldError>}
    </div>
  )
}
