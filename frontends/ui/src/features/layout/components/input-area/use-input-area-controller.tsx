import {
  useState,
  useCallback,
  useRef,
  useEffect,
  useLayoutEffect,
  useMemo,
  useId,
  type ClipboardEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react'
import { AtSign, Eye } from 'lucide-react'
import { toast } from 'sonner'

import {
  motionQuick,
  motionQuickExit,
  useIconSwapTransition,
  useMotionToken,
} from '@/components/motion'
import { useWebSocketChat, useIsCurrentSessionBusy } from '@/features/chat'
import { useChatStore } from '@/features/chat/store'
import { useRestrictingOtherProjects } from '@/features/chat/hooks/use-restricting-other-projects'
import { useChatScreening } from '@/features/chat/hooks/use-chat-screening'
import type { MaskedText } from '@/lib/upload-screening/content-screen'
import { composerCapabilities } from '@/features/collaboration/lib/composer-capabilities'
import { resolveAddressee, sendMessageOptions } from '@/features/collaboration/lib/composer-routing'
import { useLayoutStore } from '../../store'
import { computePresetSourceIds } from '../../lib/source-presets'
import {
  FIELD_SIZING_CONTENT,
  SEND_CONTROL_SWAP_GUARD_MS,
  TEXTAREA_MAX_HEIGHT_PX,
  mentionRefusalMessage,
  normalizeSendResult,
  releaseSoftKeyboard,
} from './composer-helpers'
import { useChatDropTarget } from '../chat-drop-zone'
import { composerDropRefusal } from '../../lib/composer-drop-refusal'
import { useAppConfig } from '@/shared/context'
import { useLocale, useTranslations } from '@/i18n'
import { captureCopy } from '@/i18n/namespaces/capture'
import { chatCopy } from '@/i18n/namespaces/chat'
import { collaborationCopy } from '@/i18n/namespaces/collaboration'
import { filesCopy } from '@/i18n/namespaces/files'
import { researchCopy } from '@/i18n/namespaces/research'
import { createDictationChannel, insertTranscript, type ComposerCaret } from '@/features/dictation'
import { photoIntake, prepareSitePhotos } from '@/features/documents/lib/site-photo'
import { type AttachSource } from '../ComposerAttach'
import { useFileUpload } from '@/features/documents'
import type { TrackedFile } from '@/features/documents/types'

import type { ResolvedSubjectIdentity } from '@/features/documents/components/composer-subject-bar'
import { useFilePreviewStore } from '@/features/documents/stores/file-preview-store'
import { useFilePeekBesideChat } from '@/features/documents/components/file-preview-host'

import {
  type MentionPickerAria,
  type MentionPickerHandle,
} from '@/features/collaboration/components/MentionPicker'
import { useAwaitingState, useMentionCandidates } from '@/features/collaboration/hooks/use-sharing'
import {
  bumpThreadRevision,
  useThreadRole,
  useThreadSharing,
  useTurnActorName,
} from '@/shared/collaboration/thread-sharing'
import { useTypingBroadcast } from '@/features/collaboration/hooks/use-typing-broadcast'
import {
  findMentionQuery,
  insertMention,
  type DraftMention,
  type MentionQuery,
} from '@/lib/mentions/mention-text'
import { type MentionCandidate } from '@/lib/mentions/types'
import { useSlashCommand } from '@/features/skills/hooks/use-slash-command'
import { useDocumentReference } from '@/features/search'
import type { DocumentHit } from '@/lib/search/search-wire'

/** Connection mode for the chat */
export type ConnectionMode = 'sse' | 'websocket'

/**
 * A message the composer did not send because it contains something the
 * office's „Sensible Daten" policy covers (ADR-0086): what was typed, what it
 * would be masked to, and — when the send was a resumed upload hold — the
 * held text it came from.
 */
interface ScreeningHold {
  original: string
  masked: MaskedText
  heldText?: string
}

export interface InputAreaProps {
  /** Placeholder text */
  placeholder?: string
  /** Whether the user is authenticated */
  isAuthenticated?: boolean
  /** Connection mode: 'websocket' auto-connects, 'sse' disables auto-connect (default: 'websocket') */
  connectionMode?: ConnectionMode
  /** Name of the active project, shown in the composer scope chip */
  projectName?: string
  /**
   * Whether the collaboration surfaces are reachable for this org (ADR-0032…0035,
   * dark-launched behind the per-org `collaboration` flag).
   *
   * **Defaults to false, and false means "exactly today"** (spec NF-8): no
   * addressee statement, no hand-off read, no extra request. The `@` picker is
   * gated differently — by whether the candidates endpoint answers at all — so a
   * gated org cannot notice either of them.
   */
  canCollaborate?: boolean
  /** Whether the reader may chat in this project (`project:chat`). */
  canChatInProject?: boolean
}

export function useInputAreaController({
  placeholder,
  isAuthenticated = false,
  connectionMode = 'websocket',
  projectName,
  canCollaborate = false,
  canChatInProject = true,
}: InputAreaProps) {
  const t = useTranslations(researchCopy)
  const tChat = useTranslations(chatCopy)
  const tCollab = useTranslations(collaborationCopy)
  const tFiles = useTranslations(filesCopy)
  const { locale } = useLocale()
  const [message, setMessage] = useState('')
  // Voice dictation: where the caret last was (null until the textarea has had
  // one), and the inline error a failed dictation shows. A failure never
  // touches `message`.
  const dictationCaretRef = useRef<ComposerCaret | null>(null)
  /**
   * One quiet line above the control row for what the composer has to say
   * about capture: a dictation that failed, a microphone that cannot be used
   * (said on a press, because a touch screen has no hover), a HEIC photo this
   * browser could not convert. Upload failures keep their own alert.
   */
  const [composerNote, setComposerNote] = useState<{ text: string; tone: 'error' | 'info' } | null>(
    null
  )
  const rememberDictationCaret = useCallback((e: { currentTarget: HTMLTextAreaElement }) => {
    dictationCaretRef.current = {
      start: e.currentTarget.selectionStart,
      end: e.currentTarget.selectionEnd,
    }
  }, [])

  // ——— @-mentions (spec MN-3, MN-4) ————————————————————————————————————————
  // The mentions the user actually PICKED, as structured references. Never derived
  // from the text; reconciled against it right before sending.
  const [mentions, setMentions] = useState<DraftMention[]>([])
  // The `@…` fragment under the caret; its presence is what opens the picker.
  const [mentionQuery, setMentionQuery] = useState<MentionQuery | null>(null)
  // Esc (or clicking away) closes the picker for THIS fragment; a fresh `@`
  // reopens it, however many times the user types one.
  const [mentionDismissed, setMentionDismissed] = useState(false)
  // Candidates are fetched lazily — a composer that never sees an `@` never asks.
  const [mentionRequested, setMentionRequested] = useState(false)
  const [mentionAria, setMentionAria] = useState<MentionPickerAria>({
    listboxId: null,
    activeOptionId: null,
  })
  const mentionPickerRef = useRef<MentionPickerHandle>(null)
  const composerRef = useRef<HTMLDivElement>(null)
  // Caret to restore after a programmatic text change (mention insertion).
  const pendingCaretRef = useRef<number | null>(null)

  // Attached-file preview (read-only): a successful chip opens the shared
  // FilePreviewDialog for its file. Also the primary file-access path on mobile.
  const [previewFile, setPreviewFile] = useState<TrackedFile | null>(null)
  // Datenbasis popover. Controlled so the trigger knows whether a change the
  // reader just made is visible to them in the open picker, or needs its own
  // one-shot receipt on the closed trigger.
  // Withheld with the Datenbasis picker below — restore together.
  // const [sourcesOpen, setSourcesOpen] = useState(false)
  /** Last session upload this composer auto-bound, so clearing the bar does not re-bind. */
  const boundSessionUploadRef = useRef<string | null>(null)
  // Manage-files dialog/sheet open state — driven by BOTH the desktop button and
  // the mobile "N Dateien verwalten" text entry, so it is controlled (not
  // trigger-bound) and one dialog instance serves both breakpoints.
  const [manageFilesOpen, setManageFilesOpen] = useState(false)

  // Textarea ref for the autosize effect
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  /** The composer stack, the scope an Escape-to-stop has to come from. */
  const composerRootRef = useRef<HTMLDivElement>(null)

  // Get file upload configuration from app config
  const { fileUpload: fileUploadConfig } = useAppConfig()

  // Check if current session is busy with operations
  const isBusy = useIsCurrentSessionBusy()

  /*
    WebSocket chat hook for full HITL support.

    `canCollaborate` decides WHEN the agent socket opens, not whether. With the flag
    off (the default) it opens on mount exactly as it always has. With the flag on it
    opens on mount for a private thread too — but in a SHARED thread it waits for the
    user to show they mean to write, because the Python socket registry is keyed by
    conversation id, so a reader who merely opened the thread would take the asker's
    registration away from him. See the socket-gate block in `use-websocket-chat`.
  */
  const wsChat = useWebSocketChat({
    autoConnect: connectionMode === 'websocket',
    canCollaborate,
  })

  // The open conversation's id, for filtering files and for ensureSession's
  // auto-creation. Only the id: the conversation is a new object on every
  // streamed delta, and the composer has no reason to re-render with it.
  const currentConversationId = useChatStore((state) => state.currentConversation?.id)
  const ensureSession = useChatStore((state) => state.ensureSession)
  /**
   * Create the conversation ROW, not just the client-side session.
   *
   * `ensureSession` mints a client id and puts a session in the store; the
   * server row is written by `_appendMessage` at send time. That is fine for
   * everything except the mention picker, which asks the server about a
   * conversation the server has never heard of — see the block above
   * `mentionRetryRef` for why that 404 was terminal.
   */
  const ensureConversationExists = useChatStore((state) => state._ensureConversationExists)

  // One-shot composer prefill from deep links (?ask=) and welcome-screen chips.
  const composerPrefill = useChatStore((state) => state.composerPrefill)
  const consumeComposerPrefill = useChatStore((state) => state.consumeComposerPrefill)
  const composerSubject = useChatStore((state) => state.composerSubject)
  const setComposerSubject = useChatStore((state) => state.setComposerSubject)
  const previewFileId = useFilePreviewStore((state) => state.file?.id ?? null)
  // "Is the subject's file on screen?" — asked of the SHELL, not of the store.
  // The store's `mode`/`hidden` pair says what the reader asked for; it does
  // not know about the research panel, the phone breakpoint or the Files route,
  // each of which takes the pane off screen without touching either field. Read
  // from the store alone, this said "visible" while nothing was — and since it
  // is what hides `Show file`, the one control that could bring the document
  // back was withheld exactly when it was needed. `expanded` counts on its own:
  // that is the file over the whole page, which is certainly on screen.
  const previewExpanded = useFilePreviewStore((state) => state.mode === 'expanded' && !state.hidden)
  const peekBesideChat = useFilePeekBesideChat()
  const fileDockVisible =
    (peekBesideChat || previewExpanded) &&
    previewFileId !== null &&
    previewFileId === composerSubject?.resourceId

  // Per-session composer drafts: the user's own in-progress text, persisted
  // per conversation id so it survives session switches AND reloads.
  const getComposerDraft = useChatStore((state) => state.getComposerDraft)
  const setComposerDraft = useChatStore((state) => state.setComposerDraft)
  const clearComposerDraft = useChatStore((state) => state.clearComposerDraft)

  // Active session id — the key under which this session's draft is stored.
  const currentSessionId = currentConversationId
  // Tracks which session's draft is currently loaded into `message`, so the
  // draft-sync effect only reloads when the ACTIVE session actually changes
  // (never on every keystroke). Pre-set by handleValueChange when a first
  // keystroke lazily creates a session, so that id transition doesn't wipe text.
  const loadedDraftSessionRef = useRef<string | undefined>(undefined)

  // File upload hook - provides session files and handles validation internally.
  // Attachments go through `/api/session/documents` (type gate, quota, a row).
  const chatProjectId = useChatStore((state) => state.projectId)
  // The other projects that restrict this chat now (ADR-0094), as the server judges it, for the notice.
  const otherProjects = useRestrictingOtherProjects(currentConversationId)
  const {
    uploadFiles,
    sessionFiles,
    deleteFile,
    retryFile,
    isUploading,
    error: uploadError,
    clearError,
  } = useFileUpload({
    collectionName: currentConversationId,
    conversationProjectId: chatProjectId,
  })

  // Count of files still uploading/ingesting for the current session. Drives
  // the "still processing" hint on the send button, and holds a submitted
  // message until it reaches zero (`heldForUpload` below): a question sent
  // while its attachment is still being read would be answered without it.
  const pendingCount = sessionFiles.filter(
    (f) => f.status === 'uploading' || f.status === 'ingesting'
  ).length

  /**
   * A message the composer accepted while its file was still being read.
   *
   * THE FILE IS THE QUESTION, AND IT WAS NOT THERE YET. Attaching a plan and
   * asking about it in the same breath is the normal way to use this product,
   * and it did not work: nothing about a session upload is inline — ingestion
   * runs asynchronously behind a small worker pool with a per-page vision
   * budget — so the turn was answered against a collection that was still
   * empty. The agent is not told a file is in flight either (the per-turn
   * inventory reads the summaries table, which is written only when the job
   * finishes), so it answered confidently from everything except the document
   * the question was about.
   *
   * Blocking the send was considered and rejected once already, for good
   * reason: it makes the composer refuse a person who has something to say.
   * Holding is the third option. The message leaves the composer exactly as if
   * it had been sent, a line says what it is waiting for, and it goes the
   * moment the file is readable — so the common case costs the user nothing
   * and reads as Piloti being careful rather than as Piloti being slow.
   */
  const [heldForUpload, setHeldForUpload] = useState<string | null>(null)
  // A message that matched the office's „Sensible Daten" (ADR-0086): shown,
  // not sent, until the person picks „Maskiert senden" or „Bearbeiten".
  const [screeningHold, setScreeningHold] = useState<ScreeningHold | null>(null)
  const screenChat = useChatScreening()

  // An upload into this chat IS the thing the next send is about. Without a
  // subject the agent never receives focus_file_name and walks project +
  // Archiv instead (#429). Bind the latest ready file; do not re-bind after
  // the user clears the bar.
  useEffect(() => {
    const ready = sessionFiles.filter(
      (file) => file.status === 'success' || file.status === 'ingesting'
    )
    if (ready.length === 0) {
      boundSessionUploadRef.current = null
      return
    }
    const latest = ready[ready.length - 1]
    const id = latest.serverFileId ?? latest.id
    if (boundSessionUploadRef.current === id) return
    const current = useChatStore.getState().composerSubject
    if (current && current.resourceId !== boundSessionUploadRef.current) return
    boundSessionUploadRef.current = id
    setComposerSubject({
      resourceType: 'document',
      resourceId: id,
      title: latest.fileName,
      filename: latest.fileName,
      shelf: 'session',
    })
  }, [sessionFiles, setComposerSubject])

  // Stable across renders: this composer re-renders on every keystroke, and the
  // subject bar holds this in an effect. An inline arrow here made the bar's
  // document lookup a function of how often the user typed.
  const handleSubjectResolved = useCallback(
    ({ title, filename, shelf, versionId, versionState }: ResolvedSubjectIdentity) => {
      // Read from the store, not a closure: the lookup is async and the user
      // may have cleared or re-bound the bar while it was in flight.
      const current = useChatStore.getState().composerSubject
      if (!current) return
      setComposerSubject({
        ...current,
        ...(title ? { title } : {}),
        ...(filename ? { filename } : {}),
        ...(shelf ? { shelf } : {}),
        // Merged on `!== undefined`, not on truthiness: `null` is the lookup
        // saying this document has no open version, and it has to CLEAR a pair
        // an earlier subject left behind rather than leave it standing.
        ...(versionId !== undefined ? { versionId } : {}),
        ...(versionState !== undefined ? { versionState } : {}),
      })
    },
    [setComposerSubject]
  )

  const {
    sendMessage,
    isLoading,
    respondToInteraction,
    pendingInteraction,
    noteSendIntent,
    steer,
    canSteer,
  } = wsChat

  /*
    THE CONNECTION TRIGGER: composer focus.

    Three candidates, and this is the trade we picked.

      - **The send itself** is the latest possible moment and the cheapest for a
        reader, but it puts a full WebSocket handshake in front of the first
        message of every shared thread — the user waits for it, and it is the one
        latency this fix must not add.
      - **The first keystroke** is nearly as good and strictly worse: it connects
        no earlier than focus and only saves a socket for the user who focuses the
        composer and then types nothing at all, which is rare and harmless.
      - **Focus** connects on the click or Tab that precedes the typing. By the
        time a sentence has been written the socket is warm, so the send is as fast
        as it is today, while a participant who is only READING never focuses the
        composer and never connects. That is the case the defect is about.

    Focus is not proof of intent to send, so the cost of being wrong matters: a
    reader who idly clicks the composer opens a socket they will not use. That
    costs one connection slot and, in a shared thread, can still displace the
    asker's registration — which is why the frontend fix mitigates rather than
    closes the collision (the registry has to become per-socket to close it).

    `handleSubmit` calls it again as a backstop, for the paths that send without a
    focus event ever reaching the textarea (composer prefill, deep links).
  */

  // Register respondToInteraction in the store so sibling components (e.g. AgentPrompt) can use it
  const setRespondToInteractionFn = useChatStore((state) => state.setRespondToInteractionFn)
  useEffect(() => {
    setRespondToInteractionFn(respondToInteraction)
    return () => setRespondToInteractionFn(null)
  }, [respondToInteraction, setRespondToInteractionFn])

  // Register the live send path so components that do not own the socket (e.g.
  // the "Erneut versuchen" retry on an errored answer in ChatArea) can resend
  // the last user message. Mirrors the respondToInteractionFn registration.
  const setChatSendFn = useChatStore((state) => state.setChatSendFn)
  useEffect(() => {
    setChatSendFn(sendMessage)
    return () => setChatSendFn(null)
  }, [sendMessage, setChatSendFn])

  // Layout store — individual selectors for minimal re-render surface
  const knowledgeLayerAvailable = useLayoutStore((s) => s.knowledgeLayerAvailable)
  const applySourcePreset = useLayoutStore((s) => s.applySourcePreset)
  const projectId = useChatStore((s) => s.projectId)

  useEffect(() => {
    if (!composerSubject) return
    // A session/Archiv subject is not "Projektunterlagen" — applying that
    // preset only switched RIS off and still mixed every knowledge shelf.
    if (composerSubject.shelf && composerSubject.shelf !== 'project') return
    const sources = useLayoutStore.getState().availableDataSources ?? []
    applySourcePreset('project', computePresetSourceIds('project', sources))
    // Keyed on the subject's identity fields, not the object: a re-render
    // carrying an equivalent subject must not re-apply the preset.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [composerSubject?.resourceId, composerSubject?.shelf, applySourcePreset])

  // Streaming state + cancel action for the composer stop button (C1).
  // stopStreaming is added by the STREAMING agent in messages-store; selecting
  // it defensively means the button no-ops until that half of the contract lands.
  const isStreaming = useChatStore((s) => s.isStreaming)
  const stopStreaming = useChatStore((s) => s.stopStreaming)

  // Check if we're in response mode (responding to a HITL prompt)
  const isResponseMode = !!pendingInteraction

  // The send control's one job at a time, and the glyph that says it.
  const showStop = isStreaming && !isResponseMode
  const sendGlyph: 'stop' | 'sending' | 'send' = showStop ? 'stop' : isLoading ? 'sending' : 'send'
  // When the control last changed job (SEND_CONTROL_SWAP_GUARD_MS). A layout
  // effect, so the stamp is in place before the browser can deliver the next
  // click to the re-rendered button; the first render is not a change.
  const sendControlJobRef = useRef(showStop)
  const sendControlSwappedAtRef = useRef(Number.NEGATIVE_INFINITY)
  useLayoutEffect(() => {
    if (sendControlJobRef.current === showStop) return
    sendControlJobRef.current = showStop
    sendControlSwappedAtRef.current = performance.now()
  }, [showStop])
  // An icon swap: scale on `springSnap`, opacity on a tween (opacity never
  // springs), both instant under reduced motion.
  const { enter: glyphEnter, exit: glyphExit } = useIconSwapTransition()
  // The hold line fades rather than teleports; opacity is not covered by
  // `<MotionConfig reducedMotion="user">`, so both go through the token hook.
  const holdEnter = useMotionToken(motionQuick)
  const holdExit = useMotionToken(motionQuickExit)

  // DISABLE LOGIC
  // Disable input when:
  // 1. Not authenticated
  // 2. Session is busy AND not in HITL response mode (user must be able to type approve/reject).
  //    The reader's OWN streaming turn locks only the send: the textarea stays
  //    live for the follow-up (`canDraft`, `draftLocked` below).
  // 3. Deep research has completed/failed
  // 4. A colleague's turn is running in this shared thread (the socket registry is
  //    one slot per conversation — a second send collides with it), or the reader
  //    only has the viewer role (the server would reject the send anyway)

  // Whose question Piloti is answering, when it is not this reader's — published by
  // the ADR-0033 seam so the composer does not pay for a second roster read.
  const otherPersonsTurnName = useTurnActorName(canCollaborate ? currentSessionId : null)

  // The reader's own role in a shared thread: a viewer's send is rejected
  // server-side, so the composer is read-only BEFORE the attempt (a ghost bubble
  // only the viewer would see is the alternative).
  const myThreadRole = useThreadRole(canCollaborate ? currentSessionId : null)
  const threadSharing = useThreadSharing(canCollaborate ? currentSessionId : null)

  /*
    One gate for "may this person change anything about this conversation", and
    one for "may they type right now".

    `disabled` used to reach only the textarea and the send button, so a viewer
    in a shared thread — whose whole point is that they may read and not write —
    still had a live paperclip, a live drop zone, and a live *Datengrundlage*
    popover whose toggles persist onto the conversation. They could not send a
    message but they could rewrite which sources the next person's turn would
    use, and upload files into the thread. Hence two capabilities, not one flag.

    The decision moved to `collaboration/lib/composer-capabilities` because it
    was a role-NAME comparison (`myThreadRole === 'viewer'`) where the rest of
    the codebase ranks a ladder, and because every denial was anonymous. Both
    are ADR-0038 requirements. Behaviour is unchanged, including the
    allow-while-the-role-is-unknown window, which is now a named field with a
    test on it instead of a consequence of `null !== 'viewer'`.
  */
  const capabilities = composerCapabilities({
    isAuthenticated,
    canCollaborate,
    sharing: threadSharing,
    myRole: myThreadRole,
    mayChatInProject: canChatInProject,
    isBusy,
    isResponseMode,
    otherPersonsTurn: Boolean(otherPersonsTurnName),
    ownTurnStreaming: showStop,
  })

  // Composing presence. Only where somebody could actually see it: a shared
  // thread, collaboration on, and a role that may contribute — a viewer's draft
  // will never become a message, so announcing it would be a claim about
  // something that cannot happen. The server enforces all three regardless; this
  // is what keeps a private thread from issuing the request at all (spec NF-8).
  const { onTyping, onStoppedTyping } = useTypingBroadcast({
    conversationId: currentSessionId ?? null,
    enabled: capabilities.canBroadcastTyping,
  })

  const isDisabledByAuth = !isAuthenticated
  /** Read-only because of the role specifically — drives the viewer notice. */
  const isViewerInSharedThread = capabilities.deniedBy === 'read-only-role'
  /**
   * Locked because the PROJECT does not grant `project:chat`. Its own notice,
   * and not gated on `canCollaborate`: this has nothing to do with sharing, and
   * a reader in a tenant without collaboration must still be told why the
   * composer is dead rather than watching a send fail.
   */
  const cannotChatInProject = capabilities.deniedBy === 'no-project-chat-permission'
  const cannotContribute = !capabilities.canContribute
  const disabled = !capabilities.canCompose
  /**
   * The textarea's own gate, wider than `disabled` by the reader's own streaming
   * turn: they may write the follow-up while the answer arrives, and only the
   * send waits for the settle (`handleSubmit` still guards on `disabled`).
   */
  const draftLocked = !capabilities.canDraft
  /** Typing ahead: the field is live, but Enter will not send until the settle. */
  const typingAhead = disabled && !draftLocked
  /**
   * Steering: the reader's own turn is running and its server reads notes, so
   * Enter does not wait for the settle. It sends the text into the running
   * answer as a `steer`, which Piloti reads before its next step; a note it
   * never reads is asked as the next question (`use-websocket-chat`).
   */
  const steering = typingAhead && showStop && Boolean(canSteer)
  const typeAheadHintId = useId()

  // Autosize: grow the textarea with content, capped at TEXTAREA_MAX_HEIGHT_PX.
  //
  // Where the engine has `field-sizing: content` (the Textarea atom sets it, and
  // `max-h-52` caps it) the browser sizes the box in the same layout pass as the
  // text, and there is nothing to do here — an inline height would only override
  // it. Elsewhere this measures, and it is a LAYOUT effect on purpose: a plain
  // effect runs after paint, so a send that clears a five-line draft painted one
  // frame of a tall, empty box before snapping shut, and the transcript above
  // (padded by `--composer-h`) jumped with it.
  useLayoutEffect(() => {
    if (FIELD_SIZING_CONTENT) return
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, TEXTAREA_MAX_HEIGHT_PX)}px`
  }, [message])

  // Per-session draft restore: when the ACTIVE session changes (switching
  // sessions, or a session being restored after reload/hydration), load that
  // session's saved draft into the composer. Keyed on the id — typing within a
  // session never re-triggers this (the ref guard also covers the lazy
  // ensureSession id transition, which handleValueChange marks as loaded).
  useEffect(() => {
    if (loadedDraftSessionRef.current === currentSessionId) return
    loadedDraftSessionRef.current = currentSessionId
    setMessage(currentSessionId ? getComposerDraft(currentSessionId) : '')
  }, [currentSessionId, getComposerDraft])

  // Consume a queued composer prefill exactly once: populate the draft, focus
  // the textarea, and move the caret to the end. We never auto-send — the user
  // reviews/edits before submitting. The store clears the flag on read.
  //
  // Precedence vs. an existing draft: a prefill fills an EMPTY composer only.
  // If the session already holds the user's own in-progress text (local or
  // persisted draft), the prefill is dropped — consumed without applying — so
  // a deep link or chip can never silently clobber what the user was writing.
  useEffect(() => {
    if (composerPrefill === null || isDisabledByAuth) return
    const existingDraft = currentSessionId ? getComposerDraft(currentSessionId) : ''
    const composerHasText = message.trim().length > 0 || existingDraft.trim().length > 0
    if (composerHasText) {
      consumeComposerPrefill()
      return
    }
    const prefill = consumeComposerPrefill()
    if (prefill === null) return
    setMessage(prefill.text)
    // A prefill that renders `@…` tokens carries the structured mentions with
    // it (e.g. the hand-off banner's "ask Piloti instead") — without seeding
    // them here the tokens would send as dead plain text and route to the
    // wrong addressee (spec MN-3).
    if (prefill.mentions && prefill.mentions.length > 0) setMentions(prefill.mentions)
    // Persist the prefill as the session's draft too, so it survives a reload
    // just like typed text (only possible once a session exists).
    if (currentSessionId) setComposerDraft(currentSessionId, prefill.text)
    requestAnimationFrame(() => {
      const el = textareaRef.current
      if (!el) return
      el.focus()
      const end = el.value.length
      el.setSelectionRange(end, end)
    })
  }, [
    composerPrefill,
    consumeComposerPrefill,
    isDisabledByAuth,
    currentSessionId,
    getComposerDraft,
    setComposerDraft,
    message,
  ])

  // Dynamic placeholder based on state
  // Note: isResponseMode is checked before isBusy because the user needs to
  // see the response prompt even when the session is "busy" due to HITL.
  // The research locks reuse their helper sentence here rather than carrying
  // a third wording for the same fact.
  const getPlaceholder = (): string => {
    if (!isAuthenticated) return t('inputArea.signInToStart')
    if (isResponseMode) return t('inputArea.typeResponse')
    if (steering) return t('inputArea.steer')
    // Before the subject line: while the field is live but Enter waits for the
    // settle, the placeholder is the one place that says so without a hint
    // competing with the answer for attention.
    if (typingAhead) return t('inputArea.typeAhead')
    if (isBusy) return t('inputArea.pleaseWait')
    if (composerSubject) {
      return tFiles('assignment.askingAbout', {
        name: composerSubject.title?.trim() || tFiles('assignment.thisFile'),
      })
    }
    return placeholder ?? tChat('composer.placeholder')
  }

  // Mention candidates for this conversation — the agent, the participants, and the
  // colleagues who would have to be invited (spec MN-4/MN-5).
  // `canCollaborate` gates the REQUEST, not just the picker. Without it, typing
  // `@` with the feature off still fired this fetch at a route that answers 403,
  // and `mentionsLoading` alone was enough to open the picker (below) — so the
  // panel flashed open and vanished, advertising a feature this deployment does
  // not have (spec NF-8). The gate has to sit on the fetch: any other placement
  // leaves the round-trip, and the flicker is the round-trip.
  const {
    data: mentionData,
    loading: mentionsLoading,
    restart: restartMentionCandidates,
  } = useMentionCandidates(currentSessionId ?? null, canCollaborate && mentionRequested)

  /**
   * A FRESH `@` IS FRESH EVIDENCE, AND THE THREAD MAY SINCE HAVE BEEN PERSISTED.
   *
   * A conversation row reaches the server only with its first persisted
   * message, so a `@` typed before anything was sent reads candidates that
   * 404. The retry ladder in the hook covers a few seconds of that; past its
   * last rung it gives up, and nothing re-armed it — `refresh` is keyed on the
   * conversation id, which does not change when the row finally appears, and
   * `mentionRequested` latches true on the first `@` so the enable flag never
   * flips either. The result was a picker that stayed dead for the rest of that
   * thread unless the reader happened to blur and refocus the tab.
   *
   * Held in a ref rather than a dependency because `syncMentionQuery` runs on
   * every keystroke and every caret move; a changing identity there would make
   * the mention trigger a function of how fast someone types.
   */
  const mentionRetryRef = useRef<(() => void) | null>(null)
  // `mentionRequested` is NOT part of this condition, and that omission is half
  // the fix. It latches true only in `syncMentionQuery`'s own edge branch, i.e.
  // in the same event that reads this ref — so on the FIRST `@` of a window it
  // was still false from the previous render, the ref was null, and the re-arm
  // could not fire on the one interaction that needed it. It could only ever
  // help from the second fragment onward.
  mentionRetryRef.current =
    mentionData === null && !mentionsLoading ? restartMentionCandidates : null
  /**
   * Make the conversation real before the picker asks about it.
   *
   * Held in a ref for the same reason the retry is: `syncMentionQuery` runs on
   * every keystroke and every caret move, and a changing dependency there would
   * make the mention trigger a function of how fast someone types.
   */
  const ensureConversationRef = useRef<() => void>(() => {})
  ensureConversationRef.current = () => {
    // `ensureSession` writes to the store synchronously, so the id
    // `_ensureConversationExists` then reads is the one just minted.
    // `ensureServerConversation` is idempotent and shares one in-flight promise
    // per id, so the send path pays nothing extra for this.
    ensureSession()
    void ensureConversationExists()
  }
  /** Whether the caret was already inside an `@…` fragment on the last sync. */
  const mentionFragmentOpenRef = useRef(false)

  /**
   * Re-evaluate whether the caret sits in an `@…` fragment. Called on every text
   * change and on every caret move, which is what makes the trigger feel native:
   * typing `@` opens the picker, deleting the `@` closes it, and clicking back into
   * an unfinished fragment picks it up again.
   */
  const syncMentionQuery = useCallback((value: string, caret: number | null) => {
    const range = caret === null ? null : findMentionQuery(value, caret)
    setMentionQuery(range)
    if (range) {
      // Only on the EDGE — the keystroke that opens a fragment. Asking again on
      // every character of `@Mar…` would be a fetch per keystroke.
      if (!mentionFragmentOpenRef.current) {
        // The row FIRST, then the retry.
        //
        // In a new window there is no conversation: the logo, the new-chat path
        // and `?new` all null it, and typing `@` only ever created a
        // CLIENT-SIDE session. So the picker asked
        // `/api/conversations/<clientId>/mention-candidates` about a row that
        // does not exist, got 404 through every rung of the retry ladder, and
        // the hook cleared its data — which renders NO picker at all, not an
        // empty one. Re-arming that ladder against the same missing row could
        // only 404 again, which is why the previous fix did not help here.
        //
        // Scoped to this edge rather than to every first keystroke, so only
        // readers who actually reached for the picker pay the round trip.
        // `deleteConversation` already removes the server row, so an abandoned
        // draft cleans up.
        ensureConversationRef.current()
        mentionRetryRef.current?.()
      }
      mentionFragmentOpenRef.current = true
      setMentionRequested(true)
      return
    }
    mentionFragmentOpenRef.current = false
    // No fragment → nothing to dismiss; the next `@` starts clean.
    setMentionDismissed(false)
  }, [])

  // Declared here rather than beside the other handlers below: `handleMentionSomeone`
  // lists it as a dependency, so a later `const` would be read in its own TDZ.
  const handleValueChange = useCallback(
    (value: string, caret: number | null = value.length) => {
      if (isDisabledByAuth) return // Don't allow typing when not authenticated

      // Persist a session as soon as the user starts interacting via typed input.
      // This keeps logo-triggered "new session" drafts out of history until touched.
      let sessionId = currentConversationId
      if (!sessionId && value.trim().length > 0) {
        sessionId = ensureSession()
        // ensureSession just activated a brand-new session; mark its id as the
        // loaded draft so the draft-sync effect doesn't reset the text we set here.
        if (sessionId) loadedDraftSessionRef.current = sessionId
      }

      setMessage(value)
      // The notice describes the text it was raised for; an edit retires it,
      // and the next send screens the new text.
      setScreeningHold(null)
      // Persist the draft under the active session (once one exists) so it
      // survives navigating away/back and a reload.
      if (sessionId) setComposerDraft(sessionId, value)
      syncMentionQuery(value, caret)
      syncSlashQueryRef.current?.(value, caret ?? value.length)
      syncReferenceQueryRef.current?.(value, caret ?? value.length)
      // Tell the thread. Throttled inside the hook, so this is a comparison on
      // most keystrokes; emptying the box withdraws the claim rather than letting
      // it expire, because "cleared the draft" is exactly when a colleague should
      // stop expecting a message.
      if (value.trim()) onTyping()
      else onStoppedTyping()
    },
    [
      isDisabledByAuth,
      currentConversationId,
      ensureSession,
      setComposerDraft,
      syncMentionQuery,
      onTyping,
      onStoppedTyping,
    ]
  )

  /**
   * Start a mention from the composer's addressee line — the only affordance that
   * teaches `@` exists (spec MN-3 had no discovery story at all).
   *
   * Types the character rather than opening the picker directly: `syncMentionQuery`
   * already owns "the caret sits in an `@…` fragment", so going through the text is
   * the one path that cannot drift from what typing `@` by hand does. It also leaves
   * the user somewhere sensible if they change their mind — one backspace.
   */
  const handleMentionSomeone = useCallback(() => {
    // Belt and braces with the `undefined` handler at the call site: this one is
    // reachable by anything holding a stale reference, and it writes to the
    // conversation's draft.
    if (cannotContribute) return
    const el = textareaRef.current
    const base = message.length > 0 && !message.endsWith(' ') ? `${message} ` : message
    const next = `${base}@`
    // Route through handleValueChange, not a bare setMessage: a fresh thread
    // gets its session (and the draft) here, and `syncMentionQuery` runs inside
    // it — the one path that cannot drift from what typing `@` by hand does.
    handleValueChange(next, next.length)
    setMentionDismissed(false)
    // Focus AFTER the value lands, so the caret is at the end of the fragment the
    // picker is filtering on.
    requestAnimationFrame(() => {
      el?.focus()
      el?.setSelectionRange(next.length, next.length)
    })
  }, [message, handleValueChange, cannotContribute])

  const syncMentionQueryFromElement = useCallback(
    (element: HTMLTextAreaElement) => {
      syncMentionQuery(element.value, element.selectionStart)
      syncSlashQueryRef.current?.(element.value, element.selectionStart)
      syncReferenceQueryRef.current?.(element.value, element.selectionStart)
    },
    [syncMentionQuery]
  )

  /*
    `/skill` invocation. All of its behaviour lives in `useSlashCommand`; the
    composer supplies the text, a way to replace it, and the picker.

    The ref indirection exists because `handleValueChange` (defined above, and a
    dependency of half this component) has to feed the hook, while the hook needs
    `handleValueChange` to write text back. Rather than reorder a 2000-line
    component around a new feature, the sync function is published into a ref the
    earlier callbacks read — the one edge where this feature touches existing
    code paths, and it is inert until the user types a slash.
  */
  const syncSlashQueryRef = useRef<((text: string, caret: number) => void) | null>(null)
  const replaceComposerText = useCallback(
    (text: string, caret: number) => {
      pendingCaretRef.current = caret
      handleValueChange(text, caret)
    },
    [handleValueChange]
  )
  const slash = useSlashCommand({
    text: message,
    // A message the agent is not being asked to answer cannot invoke a skill:
    // `contextOnly` sends are remarks to the thread (ADR-0034 addendum), and a
    // skill that force-activates on a turn nobody asked for would be a silent
    // cost. `cannotContribute` covers the read-only cases.
    enabled: !cannotContribute && !isResponseMode,
    onReplaceText: replaceComposerText,
  })
  syncSlashQueryRef.current = slash.syncQuery

  /*
    `#` puts a document of the workspace into the message (`useDocumentReference`):
    the live workspace search, documents only, in this chat's project. A pick
    writes the name into the text and makes the document the message's subject,
    exactly what „Piloti fragen" on a file does (`askAboutFile`), so the subject
    bar, the peek and the turn's focus follow from the one mechanism. Published
    through a ref for the reason the slash one is.
  */
  const syncReferenceQueryRef = useRef<((text: string, caret: number) => void) | null>(null)
  const referenceScope = useMemo(
    () => (projectId ? { scope: 'project' as const, projectId } : {}),
    [projectId]
  )
  const pickReference = useCallback(
    (hit: DocumentHit) =>
      setComposerSubject({
        resourceType: 'document',
        resourceId: hit.id,
        title: hit.title ?? hit.name,
        filename: hit.filename,
        shelf: hit.shelf,
      }),
    [setComposerSubject]
  )
  const reference = useDocumentReference({
    text: message,
    enabled: !cannotContribute,
    scope: referenceScope,
    onReplaceText: replaceComposerText,
    onPick: pickReference,
  })
  syncReferenceQueryRef.current = reference.syncQuery

  // A transcript goes in at the caret, or at the end when there was none, and
  // never over existing text. Through `replaceComposerText`, so the draft, the
  // session and the pickers see it exactly as they see typing.
  const handleTranscript = useCallback(
    (transcript: string) => {
      const inserted = insertTranscript(message, transcript, dictationCaretRef.current)
      if (!inserted) return
      setComposerNote(null)
      dictationCaretRef.current = { start: inserted.caret, end: inserted.caret }
      replaceComposerText(inserted.value, inserted.caret)
    },
    [message, replaceComposerText]
  )

  // The microphone's state reaches the recording strip through a channel, not
  // through this component: a recording publishes a level every 60ms, and the
  // whole composer re-rendering at that rate is the jank a strip must not cost.
  const dictationChannel = useMemo(() => createDictationChannel(), [])
  const reportDictationError = useCallback(
    (text: string) => setComposerNote({ text, tone: 'error' }),
    []
  )
  const explainDictation = useCallback(
    (reason: string) => setComposerNote({ text: reason, tone: 'info' }),
    []
  )

  // Restore the caret after a mention insertion rewrote the text.
  useEffect(() => {
    const caret = pendingCaretRef.current
    if (caret === null) return
    pendingCaretRef.current = null
    const el = textareaRef.current
    if (!el) return
    el.focus()
    el.setSelectionRange(caret, caret)
  }, [message])

  // Mentions that survive the current text, in text order — the single source for
  // what gets sent, what the hint says, and whether the agent will stay quiet.

  /*
    The thread's hand-off state, read from the server (never computed here — the
    banner, the inbox and this composer read the same rows, ADR-0034). It is what
    turns the silent default into "Geht an den Chat": while a named person is
    awaited, a plain message is a remark and the agent stays out.

    Off entirely without the flag, so a gated org opens no request (spec NF-8) —
    and off on a PRIVATE thread too. Gating on the flag alone was not enough:
    `useAwaitingState` subscribes to the shared event channel, so a solo user in a
    flag-on org opened a permanent `/api/stream` connection and polled
    `/awaiting` for a conversation that can never be waiting on anybody. NF-8 is
    the stricter promise — a user who never shares must not notice this exists —
    and `ChatArea` already reads the same state under exactly this predicate.
  */
  const { awaiting } = useAwaitingState(
    canCollaborate && threadSharing === 'shared' ? (currentSessionId ?? null) : null,
    canCollaborate && threadSharing === 'shared'
  )
  const threadAwaitsHuman = (awaiting?.pending.length ?? 0) > 0

  // ONE resolution, shared with the send below: `resolveAddressee` is the only
  // place the three-way decision is written. `@Piloti` alongside a person
  // addresses BOTH (spec MN-1), so the "Piloti stays quiet" hint would be a false
  // statement there; the addressee line names them both instead.
  //
  // Memoised so `activeMentions` keeps a stable identity across keystrokes —
  // AddresseeIndicator takes it by reference.
  const addressee = useMemo(
    () =>
      resolveAddressee({
        text: message,
        mentions,
        awaitingHuman: threadAwaitsHuman,
        canCollaborate,
      }),
    [message, mentions, threadAwaitsHuman, canCollaborate]
  )
  const activeMentions = addressee.mentions
  const taggedHumans = addressee.humans
  const agentTagged = addressee.agentTagged

  /**
   * The picker opens only where collaboration is on, and then only once the
   * candidate list is on its way.
   *
   * `canCollaborate` is checked here as well as on the fetch above — not
   * redundantly: the two answer different questions ("may this deployment mention
   * anyone?" vs. "has the list arrived?"), and stating the first one here is what
   * keeps a stale `mentionsLoading` from ever opening a panel the feature gate
   * has closed. With the feature off, typing `@` behaves exactly as it did before
   * this feature existed (spec NF-8).
   */
  const mentionPickerOpen =
    canCollaborate &&
    mentionQuery !== null &&
    !mentionDismissed &&
    // A mention only edits the draft, so it works while typing ahead too.
    !draftLocked &&
    (mentionsLoading || mentionData !== null)

  /**
   * @param heldText  A message the composer HELD rather than sent (see
   *   `heldForUpload`). Passed explicitly because it is no longer in `message`
   *   by the time the uploads settle, and a state round-trip to put it back
   *   would send whatever the user had started typing since.
   * @param maskedText  The person's „Maskiert senden" on a screening hold: the
   *   message with every match replaced, sent instead of what was typed.
   */
  const handleSubmit = useCallback(
    async (heldText?: string, maskedText?: string) => {
      const source = maskedText ?? heldText ?? message
      if (!source.trim() || (disabled && !steering)) return
      // Backstop for a send that never saw a focus event (prefill, deep link). A no-op
      // when focus already declared it.
      noteSendIntent()
      const currentMessage = source.trim()

      // The office's „Sensible Daten" (ADR-0086). A match is never sent as typed:
      // the composer says what it found and the person chooses — masked, or back
      // to the editor with the text untouched. Before the HITL branch, so an
      // answer to Piloti's question is screened like a question. Masking is
      // idempotent, so the masked text passes this check when it comes back in.
      if (maskedText === undefined) {
        const screened = screenChat(currentMessage)
        if (screened.findings.length > 0) {
          setScreeningHold({ original: currentMessage, masked: screened, heldText })
          return
        }
      }
      // Capture the session up front — the draft is cleared against THIS id on a
      // successful send, even if the session changes underneath us mid-await.
      const submittingSessionId = currentConversationId

      // The reader's own turn runs: the text goes into it as a note, not as a
      // question (screened above like one). Refused (the socket went, the turn
      // just ended), it stays in the field as typed-ahead text.
      if (disabled && steering) {
        if (!steer({ text: currentMessage })) return
        setMessage('')
        setMentionQuery(null)
        onStoppedTyping()
        if (submittingSessionId) clearComposerDraft(submittingSessionId)
        return
      }

      // HITL responses always go through immediately — no file-pending check
      if (isResponseMode && respondToInteraction) {
        setMessage('')
        releaseSoftKeyboard(textareaRef.current)
        onStoppedTyping()
        if (submittingSessionId) clearComposerDraft(submittingSessionId)
        respondToInteraction(currentMessage)
        return
      }

      // Mentions are structured, and reconciled against the text at the last
      // possible moment: whatever token the user deleted while editing is not sent
      // (spec MN-3).
      // The SAME function the addressee line used, over the same inputs — so what
      // the user was told and what happens cannot disagree by construction, rather
      // than by two expressions being kept in step by tests.
      const sent = resolveAddressee({
        text: currentMessage,
        mentions,
        awaitingHuman: threadAwaitsHuman,
        canCollaborate,
      })
      const sentHumans = sent.humans

      // A file is still being read, and this message is about it. Hold rather
      // than send: see `heldForUpload`. `heldText` means this IS the resumed
      // send, so it must not be held a second time.
      if (heldText === undefined && pendingCount > 0) {
        setHeldForUpload(currentMessage)
        setMessage('')
        setMentionQuery(null)
        onStoppedTyping()
        return
      }

      setMessage('')
      setMentionQuery(null)
      releaseSoftKeyboard(textareaRef.current)
      // The draft became a message; the claim has served its purpose and the
      // message itself is the better signal from here on.
      onStoppedTyping()
      try {
        // sendMessage reports immediate failures (dead socket, no conversation)
        // via a false return rather than throwing. A message WITH mentions resolves
        // to the server's addressee ruling instead, and may be refused outright.
        const { ok, outcome } = normalizeSendResult(
          // Called with ONE argument when there is nothing to mention AND the thread
          // is in its normal state — the fast path stays exactly the call it always
          // was, free of the feature.
          //
          // `awaitingHuman` is what makes a plain message go through the server's
          // ruling too: while a named person is awaited it is a remark to the thread,
          // not a question for Piloti (ADR-0034 addendum), and the agent must be given
          // it as context rather than as a turn.
          //
          // The shape comes from `sendMessageArgs`, so the fast path stays the
          // literal one-argument call it always was — an explicit `undefined` would
          // push plain messages down the server's ruling path.
          await (() => {
            // One ternary, not a re-derivation: `sendMessageOptions` already chose
            // the case. Omitting the argument entirely is what keeps the fast path
            // the literal single-argument call it has always been.
            //
            // A `/name` invocation adds NOTHING here any more. The picker writes
            // the skill's name into the message text and that is the whole of it:
            // the model reads the name and picks the skill out of its catalog,
            // rather than the turn being handed a skill it must apply. What the
            // office always wants applied is a standing instruction, and those
            // live in the platform prompt and the organization's own instruction
            // block — not in a per-message field somebody has to remember.
            const options = sendMessageOptions(sent.routing)
            return options ? sendMessage(currentMessage, options) : sendMessage(currentMessage)
          })()
        )
        if (!ok) {
          // Restore the text so nothing the user wrote is lost, and keep the picked
          // mentions with it — the message is meant to be sent again, not retyped.
          setMessage(currentMessage)
          const refusal = mentionRefusalMessage(outcome, sentHumans, tCollab)
          toast.error(refusal ?? t('inputArea.messageNotSent'), {
            description: refusal ? undefined : t('inputArea.messageNotSentDesc'),
          })
          return
        }
        // Sent successfully — drop this session's saved draft so it can't
        // resurface on the next visit. Only on success: a failed send keeps the
        // draft so nothing the user typed is lost.
        if (submittingSessionId) clearComposerDraft(submittingSessionId)
        setMentions([])
        /*
        A mention can make a PRIVATE thread shared — the server writes the grant
        and opens the request as part of storing the message. The seam that reads
        sharedness only reads it when the conversation changes, and every live
        subscription that would carry the news is gated on the very flag that is
        now stale, so without this the asker sent their first `@` and the product
        did nothing at all: no waiting banner, no explanation for Piloti's
        silence, no way back short of reloading the page.
      */
        if (sent.mentions.length > 0 && submittingSessionId) {
          bumpThreadRevision(submittingSessionId)
        }
      } catch (error) {
        console.error('Failed to send message:', error)
        // Restore the message so the user doesn't lose what they typed. The
        // persisted draft was never cleared, so it is retained too.
        setMessage(currentMessage)
        toast.error(t('inputArea.messageNotSent'), {
          description: t('inputArea.messageNotSentDesc'),
        })
      }
    },
    [
      message,
      mentions,
      disabled,
      steering,
      steer,
      pendingCount,
      isResponseMode,
      respondToInteraction,
      sendMessage,
      noteSendIntent,
      screenChat,
      threadAwaitsHuman,
      // handleSubmit resolves the addressee, which reads the flag — a stale value
      // would route a send against a state the user is no longer in.
      canCollaborate,
      currentConversationId,
      clearComposerDraft,
      onStoppedTyping,
      t,
      tCollab,
    ]
  )

  /**
   * The held message goes the moment the file is readable — or the moment it is
   * clear it never will be.
   *
   * `pendingCount === 0` covers both: an upload that succeeded and one that
   * failed leave the pending set the same way. That is deliberate. A message
   * must not be swallowed by a broken upload; if the file did not make it, the
   * question is still the user's to ask, and the answer will simply be the one
   * they would have got before this existed.
   */
  useEffect(() => {
    if (heldForUpload === null || pendingCount > 0) return
    const text = heldForUpload
    setHeldForUpload(null)
    void handleSubmit(text)
  }, [heldForUpload, pendingCount, handleSubmit])

  /** „Maskiert senden": the held message goes out with every match replaced. */
  const sendScreenedMasked = useCallback(() => {
    if (screeningHold === null) return
    setScreeningHold(null)
    void handleSubmit(screeningHold.heldText, screeningHold.masked.text)
  }, [screeningHold, handleSubmit])

  /** „Bearbeiten": nothing is sent; the text is where the person left it. */
  const editScreened = useCallback(() => {
    if (screeningHold === null) return
    setScreeningHold(null)
    // A resumed upload hold had already left the editor: put it back, unless
    // the person has started something new there since.
    if (screeningHold.heldText !== undefined && !message.trim()) setMessage(screeningHold.original)
    textareaRef.current?.focus()
  }, [screeningHold, message])

  /** Give up waiting and ask now, without the file. */
  const sendHeldNow = useCallback(() => {
    if (heldForUpload === null) return
    const text = heldForUpload
    setHeldForUpload(null)
    void handleSubmit(text)
  }, [heldForUpload, handleSubmit])

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      // Mid-IME-composition, every key below belongs to the input method: the
      // Enter that confirms a CJK candidate must never SEND, and the arrows
      // that move through candidates must not drive the pickers. Same guard the
      // shell shortcuts use (`keyboard-shortcuts.tsx`). Safari ends the
      // composition BEFORE the keydown that confirmed it, so that key arrives
      // with `isComposing` false and only keyCode 229 says it was the IME's.
      if (e.nativeEvent.isComposing || e.keyCode === 229) return

      // The `/` picker gets first refusal on the navigation keys. It and the
      // mention picker are mutually exclusive by caret position (a slash query
      // only exists while the caret is inside the message's opening token), so
      // the order here is a formality rather than a precedence rule.
      if (slash.handleKeyDown(e, handleSubmit)) return
      // The `#` picker likewise: its fragment and the others' never share a caret.
      if (reference.handleKeyDown(e, handleSubmit)) return

      // While the picker is open it owns the navigation keys. The single most
      // important detail: Enter must INSERT, never submit — a message sent because
      // the user confirmed a name is the worst possible outcome here.
      if (mentionPickerOpen) {
        if (e.key === 'ArrowDown') {
          e.preventDefault()
          mentionPickerRef.current?.move(1)
          return
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault()
          mentionPickerRef.current?.move(-1)
          return
        }
        if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
          e.preventDefault()
          if (mentionPickerRef.current?.selectActive()) return
          // Nothing to insert (no match for what was typed): close the picker. An
          // Enter then still means what it usually means — send.
          setMentionDismissed(true)
          if (e.key === 'Enter') handleSubmit()
          return
        }
        if (e.key === 'Escape') {
          // Stop here: an Escape that bubbles would close the surrounding surface.
          e.preventDefault()
          e.stopPropagation()
          setMentionDismissed(true)
          textareaRef.current?.focus()
          return
        }
      }

      if (e.key !== 'Enter') return
      // Shift+Enter inserts a newline — let the textarea handle it natively.
      if (e.shiftKey) return
      // A held Enter sends once. Its repeats would otherwise land on whatever
      // the send became: swallowed mid-turn, then the typed-ahead draft the
      // moment the turn settles.
      if (e.repeat) {
        e.preventDefault()
        return
      }
      // Plain Enter sends; Cmd/Ctrl+Enter also sends as a discoverable power
      // binding. Both funnel through a single handleSubmit call (no double-fire),
      // and handleSubmit enforces the disabled/streaming/HITL guards.
      //
      // Typing ahead during the reader's own turn, Enter is swallowed: no newline
      // lands in the draft and `handleSubmit` refuses on `disabled`, so the text
      // stays put until the settle turns the button back into Send. Deliberately
      // silent rather than a "sends after the answer" hint — the placeholder has
      // already said it, the Stop glyph says the turn is still running, and a
      // notice flashing under the answer on every Enter is motion competing with
      // the one thing the reader is watching. Nothing is queued either: a queued
      // send would fire on a settle the reader may not have read yet.
      e.preventDefault()
      handleSubmit()
    },
    [handleSubmit, mentionPickerOpen, slash, reference]
  )

  // Whether an Escape from <body> is still the composer's: true while the
  // composer was the last thing focused and the reader has not since clicked
  // somewhere else. Focus lands on <body> both when a send releases the soft
  // keyboard and when the reader clicks plain transcript text; only the first
  // leaves the hands on the composer. A click is the signal rather than a
  // pointerdown, so scrolling the transcript by touch keeps the claim.
  const composerHadFocusRef = useRef(false)
  useEffect(() => {
    const onFocusIn = (e: FocusEvent) => {
      composerHadFocusRef.current =
        e.target instanceof Node && (composerRootRef.current?.contains(e.target) ?? false)
    }
    const onClick = (e: MouseEvent) => {
      if (e.target instanceof Node && composerRootRef.current?.contains(e.target)) return
      composerHadFocusRef.current = false
    }
    document.addEventListener('focusin', onFocusIn)
    document.addEventListener('click', onClick, true)
    return () => {
      document.removeEventListener('focusin', onFocusIn)
      document.removeEventListener('click', onClick, true)
    }
  }, [])

  // Escape stops a streaming turn, from where the hands already are: the
  // textarea (live while its own turn runs, and focused after a send without a
  // soft keyboard) or nowhere at all (<body>, after a send released the soft
  // keyboard). A document listener rather than the textarea's onKeyDown, so both
  // are covered, scoped to keys from the composer, or from <body> while the
  // composer was the last thing used, so an Escape meant for a dialog, a menu, a
  // field elsewhere or a text selection in the transcript never cancels the
  // answer. Anything that already claimed the key (the `/` and `@` pickers
  // close themselves and preventDefault) is left alone: with a picker open, the
  // first Escape closes the picker and only the next one stops the turn. An
  // IME's Escape is the IME's, including Safari's, which arrives after
  // compositionend and is marked only by keyCode 229. A draft in the field is
  // never touched — Escape stops the answer, it does not discard the follow-up
  // being written.
  useEffect(() => {
    if (!showStop || cannotContribute) return
    const onKeyDown = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || e.isComposing || e.keyCode === 229) return
      const target = e.target
      const fromComposer =
        (target === document.body && composerHadFocusRef.current) ||
        (target instanceof Node && (composerRootRef.current?.contains(target) ?? false))
      if (!fromComposer) return
      e.preventDefault()
      stopStreaming?.()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [showStop, cannotContribute, stopStreaming])

  // The send control's press. A press that arrives just after the control
  // changed job belongs to the gesture that changed it (a double click, a
  // bounce) and is dropped rather than applied to the other job.
  const handleSendControlClick = useCallback(() => {
    if (performance.now() - sendControlSwappedAtRef.current < SEND_CONTROL_SWAP_GUARD_MS) return
    if (showStop) {
      stopStreaming?.()
      return
    }
    void handleSubmit()
  }, [showStop, stopStreaming, handleSubmit])

  // A held Enter on the focused button auto-repeats, and every repeat is a
  // click: it would run through Stop into Send (or back) as soon as the guard
  // window closed. Only the first keydown of a press activates the control.
  const handleSendControlKeyDown = useCallback((e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.repeat && e.key === 'Enter') e.preventDefault()
  }, [])

  /**
   * Insert the picked candidate: the `@fragment` becomes `@Display `, and the
   * STRUCTURED reference is recorded alongside it. The text is a rendering of the
   * mention, never its definition (spec MN-3).
   */
  const handleMentionSelect = useCallback(
    (candidate: MentionCandidate) => {
      const range = mentionQuery
      if (!range) return
      const display = candidate.isAgent
        ? tCollab('mentions.picker.agentName')
        : candidate.person.name
      const { text, caret } = insertMention(message, range, display)

      pendingCaretRef.current = caret
      handleValueChange(text, caret)
      setMentions((current) => [...current, { targetId: candidate.targetId, display }])
      setMentionQuery(null)
      setMentionDismissed(false)
    },
    [handleValueChange, message, mentionQuery, tCollab]
  )

  // Photos are accepted only where Piloti can read them (`image-upload` flag
  // AND a vision model); the attach menu says which of the two is missing.
  const photos = photoIntake(fileUploadConfig)
  const tCapture = useTranslations(captureCopy)

  const handleFilesSelected = useCallback(
    async (selected: File[], source: AttachSource = 'picker') => {
      if (selected.length === 0 || cannotContribute || isUploading || isBusy) return

      // A photo gets a name of its own before anything else sees it: the name
      // is the document's identity, and iOS calls every capture `image.jpg`,
      // so the second photo would replace the first (`site-photo.ts`).
      const { files, unconvertibleHeic } = await prepareSitePhotos(selected, {
        source,
        prefix: tCapture('photos.fileNamePrefix'),
        taken: sessionFiles.map((file) => file.fileName),
        imagesAccepted: photos.available,
      })
      if (unconvertibleHeic.length > 0) {
        setComposerNote({
          text: tCapture('photos.heicUnconvertible', { name: unconvertibleHeic.join(', ') }),
          tone: 'error',
        })
      }
      if (files.length === 0) return

      const sessionId = ensureSession()
      if (!sessionId) {
        console.error('Failed to create session for upload')
        return
      }

      // Attached files now surface as inline chips above the composer, so there
      // is no panel to auto-open — the chips give instant feedback in place.
      // The server row BEFORE the bytes, with the chat's title, project and
      // subject, which the send path would write (`ensureServerConversation`,
      // idempotent per id). An attachment is authorized on its conversation
      // (`collaborator`). `/api/session/documents/upload` would create a
      // missing row too, but only with the project, so it is the fallback.
      await ensureConversationExists()
      // Pass the (possibly just-created) session explicitly: the hook's
      // memoized collectionName still reflects the previous render, so the
      // first upload in a fresh session would otherwise abort.
      await uploadFiles(files, { collectionOverride: sessionId })
    },
    [
      ensureSession,
      ensureConversationExists,
      uploadFiles,
      cannotContribute,
      isUploading,
      isBusy,
      sessionFiles,
      photos.available,
      tCapture,
    ]
  )

  // A drop attaches the way the picker does; what it could not hand over
  // (`DropInfo`) is the shelves' concern, not an attachment's. The zone is the
  // whole chat panel (`ChatDropZone`), and while attaching is closed it says
  // why rather than letting the drop vanish.
  const attachDropped = useCallback(
    (files: File[]) => void handleFilesSelected(files),
    [handleFilesSelected]
  )
  const dropRefusal = composerDropRefusal({
    canContribute: !cannotContribute,
    isStreaming,
    awaitsAnswer: isResponseMode,
    isUploading,
    knowledgeLayerAvailable,
  })
  useChatDropTarget(
    isAuthenticated
      ? { attach: attachDropped, refusal: dropRefusal ? t(`inputArea.${dropRefusal}`) : null }
      : null
  )

  // Paste-to-attach: route any files on the clipboard (e.g. a pasted image or
  // a copied document) through the same upload path. Text pastes are left to
  // the textarea's native handling — we only intervene when files are present.
  const handlePaste = useCallback(
    (e: ClipboardEvent<HTMLTextAreaElement>) => {
      const files = Array.from(e.clipboardData?.files ?? [])
      if (files.length === 0) return
      e.preventDefault()
      void handleFilesSelected(files)
    },
    [handleFilesSelected]
  )

  // Count of files attached to the current session: in progress, readable, or
  // at rest but still attached (held back by the content check, or stored and
  // never read). A held or stored attachment needs the manage-files entry as
  // much as any other: it is how a person removes it.
  const attachedFilesCount = sessionFiles.filter(
    (f) =>
      f.status === 'uploading' ||
      f.status === 'ingesting' ||
      f.status === 'success' ||
      f.status === 'held' ||
      f.status === 'stored'
  ).length

  // Scope chip label: the active project (display-only scope; cross-project
  // search does not exist yet — spec §2.3, honest disabled option).
  const scopeLabel = projectName || tChat('composer.scopeFallback')

  // Single composer hint slot: exactly one helper line below the control row —
  // the first applicable in priority order (viewer > no-project-chat > busy >
  // mention > awaiting > research lock). Same strings and conditions as the
  // stacked lines this replaces. The Deep-Research intent echo is gone from
  // here on purpose: the pill's own title already says it, so a line would
  // state the preference twice.
  let composerHint: ReactNode = null
  if (canCollaborate && isViewerInSharedThread) {
    // Read-only participant: the composer is disabled on the same fact, and
    // this line is why.
    composerHint = (
      <p
        data-testid="composer-viewer-hint"
        className="text-muted-foreground mt-2 flex items-start gap-1.5 text-xs leading-relaxed"
        role="note"
      >
        <Eye className="mt-0.5 size-3 shrink-0 opacity-70" aria-hidden="true" />
        <span>{tCollab('thread.viewerNotice')}</span>
      </p>
    )
  } else if (cannotChatInProject) {
    // No `project:chat` in this project: the composer is dead on the same
    // fact, and this is why. Deliberately NOT behind `canCollaborate` —
    // this is a project permission, not a sharing one, so a tenant with
    // collaboration off must still get the explanation.
    composerHint = (
      <p
        data-testid="composer-project-chat-hint"
        className="text-muted-foreground mt-2 flex items-start gap-1.5 text-xs leading-relaxed"
        role="note"
      >
        <Eye className="mt-0.5 size-3 shrink-0 opacity-70" aria-hidden="true" />
        <span>{tChat('composer.noProjectChatPermission')}</span>
      </p>
    )
  } else if (canCollaborate && otherPersonsTurnName) {
    // Piloti is mid-answer for SOMEBODY ELSE (spec CC-13). The composer is
    // locked on the same fact (`otherPersonsTurnName` disables it above), and
    // without a line here that lock is unexplained — a colleague sees a dead
    // input and no reason for it. Only when the turn belongs to someone else:
    // the asker has their own typing indicator and Herleitung, so telling them
    // "Piloti is answering your question" would be noise.
    composerHint = (
      <p
        data-testid="composer-busy-hint"
        className="text-muted-foreground mt-2 flex items-start gap-1.5 text-xs leading-relaxed"
        role="note"
      >
        <span>{tCollab('thread.composerBusy', { name: otherPersonsTurnName })}</span>
      </p>
    )
  } else if (taggedHumans.length > 0 && !agentTagged) {
    // The hand-off, said out loud BEFORE sending (spec MN-7/MN-8): once a
    // person is tagged the agent will stay quiet, and the user has to know
    // that while they can still change their mind. Suppressed when `@Piloti`
    // is tagged too — then the agent DOES answer (MN-1) and this sentence
    // would be false; the addressee line above names both.
    composerHint = (
      <p
        data-testid="composer-mention-hint"
        className="text-muted-foreground mt-2 flex items-start gap-1.5 text-xs leading-relaxed"
        role="note"
      >
        <AtSign className="mt-0.5 size-3 shrink-0 opacity-70" aria-hidden="true" />
        <span>
          {/* German inflects the verb, so joining names into the singular
              string produced "Anna Berger, Tobias Kern WIRD gefragt" — wrong
              grammar in the primary product language. This i18n layer has no
              plural rules, hence two keys. */}
          {taggedHumans.length === 1
            ? tCollab('mentions.composerHint', { name: taggedHumans[0]!.display })
            : tCollab('mentions.composerHintMany', {
                names: taggedHumans.map((mention) => mention.display).join(', '),
              })}
        </span>
      </p>
    )
  } else if (canCollaborate && threadAwaitsHuman && activeMentions.length === 0) {
    // The way BACK, exactly where it is needed: while the thread waits on a
    // person, a plain message is a remark, so the composer says how to reach
    // Piloti instead of leaving that to be discovered.
    composerHint = (
      <p
        data-testid="composer-agent-hint"
        className="text-muted-foreground mt-2 flex items-start gap-1.5 text-xs leading-relaxed"
        role="note"
      >
        <span>{tCollab('mentions.addressee.agentHint')}</span>
      </p>
    )
  }

  return {
    canCollaborate,
    t,
    tChat,
    locale,
    message,
    composerNote,
    setComposerNote,
    rememberDictationCaret,
    mentionQuery,
    setMentionDismissed,
    mentionAria,
    setMentionAria,
    mentionPickerRef,
    composerRef,
    previewFile,
    setPreviewFile,
    boundSessionUploadRef,
    manageFilesOpen,
    setManageFilesOpen,
    textareaRef,
    composerRootRef,
    fileUploadConfig,
    isBusy,
    currentConversationId,
    composerSubject,
    setComposerSubject,
    fileDockVisible,
    otherProjects,
    sessionFiles,
    deleteFile,
    retryFile,
    isUploading,
    uploadError,
    clearError,
    pendingCount,
    heldForUpload,
    screeningHold,
    handleSubjectResolved,
    isLoading,
    noteSendIntent,
    knowledgeLayerAvailable,
    projectId,
    isResponseMode,
    showStop,
    sendGlyph,
    glyphEnter,
    glyphExit,
    holdEnter,
    holdExit,
    isDisabledByAuth,
    cannotContribute,
    disabled,
    draftLocked,
    typingAhead,
    steering,
    typeAheadHintId,
    getPlaceholder,
    mentionData,
    mentionsLoading,
    handleValueChange,
    handleMentionSomeone,
    syncMentionQueryFromElement,
    slash,
    reference,
    handleTranscript,
    dictationChannel,
    reportDictationError,
    explainDictation,
    threadAwaitsHuman,
    activeMentions,
    mentionPickerOpen,
    sendScreenedMasked,
    editScreened,
    sendHeldNow,
    handleKeyDown,
    handleSendControlClick,
    handleSendControlKeyDown,
    handleMentionSelect,
    photos,
    tCapture,
    handleFilesSelected,
    handlePaste,
    attachedFilesCount,
    scopeLabel,
    composerHint,
  }
}

export type InputAreaController = ReturnType<typeof useInputAreaController>
