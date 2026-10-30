/**
 * The shared thread the chat previews render (`/dev/shared-thread`,
 * `/dev/inbox-dock?page=chat`): three people and Piloti in one conversation, and
 * the `fetch` and `EventSource` shims that serve it to the real `ChatArea` with
 * no backend. One copy, so both previews show the same thread.
 */

import { useChatStore } from '@/features/chat/store'

/** `useAuth` returns this id when auth is disabled, so it is "me" in the preview. */
const ME = 'default-user'
const ANNA = 'user_anna'
const TOBIAS = 'user_tobias'

const CONVERSATION_ID = 'dev-shared-conv'

const PEOPLE = {
  [ME]: {
    userId: ME,
    name: 'Matthias Bigl',
    email: 'matthias@example.com',
    profilePictureUrl: null,
  },
  [ANNA]: { userId: ANNA, name: 'Anna Berger', email: 'anna@example.com', profilePictureUrl: null },
  [TOBIAS]: {
    userId: TOBIAS,
    name: 'Tobias Kern',
    email: 'tobias@example.com',
    profilePictureUrl: null,
  },
}

const at = (minute: number): string => new Date(Date.UTC(2026, 6, 29, 9, minute, 0)).toISOString()

/** Server message rows, exactly as `GET .../messages` returns them. */
const MESSAGE_ROWS = [
  {
    id: 'm1',
    conversationId: CONVERSATION_ID,
    role: 'user',
    authorUserId: ME,
    content:
      'Wir brauchen für den Wohnbau Nord den Nachweis für den zweiten Fluchtweg. Gilt die 40-m-Grenze auch für das nördliche Treppenhaus?',
    metadata: { messageType: 'user' },
    createdAt: at(2),
  },
  {
    id: 'm2',
    conversationId: CONVERSATION_ID,
    role: 'assistant',
    authorUserId: null,
    content:
      'Ja. Nach OIB-Richtlinie 2 darf die Gehweglänge bis zum Ausgang ins Freie oder in einen anderen Brandabschnitt 40 m nicht überschreiten. Für das nördliche Treppenhaus ergeben die Pläne 34 m, der Nachweis ist damit erbracht.',
    metadata: { messageType: 'agent_response', citations: undefined },
    createdAt: at(3),
  },
  {
    id: 'm3',
    conversationId: CONVERSATION_ID,
    role: 'user',
    authorUserId: ANNA,
    content: 'Danke – ich hänge den Fluchtwegplan gleich an, damit wir dieselbe Fassung prüfen.',
    metadata: { messageType: 'user' },
    createdAt: at(8),
  },
  {
    // Anna again: this one groups under the header above it.
    id: 'm4',
    conversationId: CONVERSATION_ID,
    role: 'user',
    authorUserId: ANNA,
    content: 'Achtung: im EG ist der Durchgang zum Innenhof laut Bestandsplan verschlossen.',
    metadata: { messageType: 'user' },
    createdAt: at(9),
  },
  {
    id: 'm5',
    conversationId: CONVERSATION_ID,
    role: 'user',
    authorUserId: TOBIAS,
    content:
      'Dann zählt der Innenhof nicht als zweiter Rettungsweg. @Piloti wie wirkt sich das auf den Nachweis aus?',
    // Structured mentions ride in the metadata and are rendered as chips; the
    // addressee ruling next to them is the SERVER's, stored at persist time (MN-2).
    metadata: {
      messageType: 'user',
      mentions: [{ targetId: 'agent:piloti', display: 'Piloti' }],
      addressees: { agent: true, users: [] },
    },
    createdAt: at(11),
  },
]

/**
 * The hand-back variant's thread: the reader asked Anna (a hand-off — the server
 * ruled `{ agent: false, users: [Anna] }`, so no turn was started), and Anna has
 * now answered. The wait is therefore closed, Piloti is out of the loop, and the
 * thread sits at the moment where the way on has to be offered.
 */
const HANDBACK_ROWS = [
  MESSAGE_ROWS[0],
  MESSAGE_ROWS[1],
  {
    id: 'h1',
    conversationId: CONVERSATION_ID,
    role: 'user',
    authorUserId: ME,
    content:
      '@Anna Berger stimmt das für den Bestand? Der Durchgang zum Innenhof ist laut Plan verschlossen.',
    metadata: {
      messageType: 'user',
      mentions: [{ targetId: ANNA, display: 'Anna Berger' }],
      // The hand-off ruling: people, and deliberately NOT the agent (MN-1/MN-7).
      addressees: { agent: false, users: [ANNA] },
    },
    createdAt: at(9),
  },
  {
    id: 'h2',
    conversationId: CONVERSATION_ID,
    role: 'user',
    authorUserId: ANNA,
    content:
      'Ja, verschlossen — im Bestandsplan von 2019 als Fluchtweg gestrichen. Der Innenhof zählt nicht.',
    // A plain message while the thread awaited her: a remark to the thread, which
    // is exactly what resolves her request.
    metadata: { messageType: 'user', addressees: { agent: false, users: [] } },
    createdAt: at(14),
  },
]

const SHARING_STATE = {
  resourceType: 'conversation',
  resourceId: CONVERSATION_ID,
  visibility: 'project',
  allowedVisibilities: ['private', 'project'],
  myRole: 'collaborator',
  canManage: false,
  canEscalate: false,
  shared: true,
  entries: [
    { person: PEOPLE[ANNA], role: 'owner', reason: 'creator', grantedBy: null },
    { person: PEOPLE[ME], role: 'collaborator', reason: 'grant', grantedBy: ANNA },
    { person: PEOPLE[TOBIAS], role: 'collaborator', reason: 'visibility-project', grantedBy: null },
  ],
}

/** Read from the URL on every call, so the shim needs no React state. */
const variant = (): string | null =>
  typeof window === 'undefined' ? null : new URLSearchParams(window.location.search).get('variant')

const isHandbackVariant = (): boolean => variant() === 'handback'
/** The live variant: a colleague's turn being WATCHED, plus somebody composing. */
const isLiveVariant = (): boolean => variant() === 'live'

/**
 * The frames the live variant replays, in the order the backend would emit them
 * (`conversation_bus` envelopes, unwrapped by `/api/conversations/:id/live`).
 *
 * Real agent-runtime shapes, not a convenient summary: the whole value of this preview is
 * that it exercises the actual reducer, so a change to the wire format shows up
 * here as a blank panel rather than passing silently.
 */
const LIVE_FRAMES: unknown[] = [
  {
    type: 'system_intermediate_message',
    id: 'st1',
    content: { name: 'Function Start: knowledge_search', payload: 'Rettungswege Innenhof' },
    status: 'in_progress',
  },
  {
    type: 'system_intermediate_message',
    id: 'st2',
    content: {
      name: 'Function Complete: knowledge_search',
      payload: '3 Treffer in OIB-Richtlinie 2',
    },
    status: 'complete',
  },
  {
    type: 'system_intermediate_message',
    id: 'st3',
    content: {
      name: 'Function Start: shallow_research_agent',
      payload: 'OIB-Richtlinie 2, Abschnitt 3 wird gelesen',
    },
    status: 'in_progress',
  },
  // The masthead, written before the prose and sent ahead of it (ADR-0066).
  {
    type: 'system_response_message',
    id: 'r0',
    parent_id: 'live-turn',
    content: { text: '' },
    status: 'in_progress',
    answer_meta: {
      v: 1,
      kind: 'ruling',
      topic: 'Innenhof als zweiter Rettungsweg',
      verdict: { value: 'Nein', subject: 'Innenhof als zweiter Rettungsweg' },
    },
  },
  {
    type: 'system_response_message',
    id: 'r1',
    parent_id: 'live-turn',
    content: { text: 'Nein. Ein Innenhof zählt nur dann als zweiter Rettungsweg, wenn er ' },
    status: 'in_progress',
  },
  {
    type: 'system_response_message',
    id: 'r2',
    parent_id: 'live-turn',
    content: { text: 'ins Freie führt und dauerhaft begehbar ist. Ist der Durchgang im EG ' },
    status: 'in_progress',
  },
  {
    type: 'system_response_message',
    id: 'r3',
    parent_id: 'live-turn',
    content: { text: 'verschlossen, entfällt er als Rettungsweg' },
    status: 'in_progress',
  },
]

/**
 * Serves the thread to the real hooks in place of the BFF. Call it at module
 * scope, so the very first fetch of the hook is already served (idempotent,
 * browser + dev only).
 */
export function installSharedThreadShim(): void {
  if (typeof window === 'undefined' || process.env.NODE_ENV !== 'development') return
  const w = window as unknown as { __sharedThreadShim?: boolean }
  if (!w.__sharedThreadShim) {
    w.__sharedThreadShim = true
    const real = window.fetch.bind(window)
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const href =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      // Matched on the path: the reads carry their paging and `include` in the query.
      const url = new URL(href, window.location.origin).pathname

      if (url === `/api/conversations/${CONVERSATION_ID}`) {
        return Response.json({
          id: CONVERSATION_ID,
          title: 'Brandschutz Stiegenhaus Nord',
          createdAt: at(0),
          updatedAt: at(11),
          shared: true,
          myRole: 'collaborator',
          visibility: 'project',
          // The reader last read up to their own answer, so the separator lands
          // above Anna's first message.
          myReadState: { lastReadAt: at(4), lastReadMessageId: 'm2' },
        })
      }
      if (url === `/api/conversations/${CONVERSATION_ID}/messages`) {
        return Response.json({
          messages: isHandbackVariant() ? HANDBACK_ROWS : MESSAGE_ROWS,
          nextCursor: null,
        })
      }
      // The derived hand-off state. Empty in both variants — in the hand-back one
      // that emptiness IS the fixture: Anna's answer closed her request, which is
      // why the banner is gone and the offer has to take over.
      if (url === `/api/conversations/${CONVERSATION_ID}/awaiting`) {
        return Response.json({ pending: [], awaitingMe: false })
      }
      if (url === `/api/sharing/conversation/${CONVERSATION_ID}`) {
        return Response.json(SHARING_STATE)
      }
      if (url === `/api/conversations/${CONVERSATION_ID}/read`) {
        return Response.json({ ok: true })
      }
      return real(input, init)
    }

    // The turn-in-flight banner is driven by a live `conversation.turn` event, so
    // the preview stands up a one-frame EventSource rather than faking the
    // component's state: the screenshot then exercises the real path
    // (event-hub → useLiveEvents → useSharedThread → banner). Replacing the
    // constructor also stops the real `/api/stream` route being polled behind an
    // auth wall for the life of the preview.
    class PreviewEventSource {
      static readonly CONNECTING = 0
      static readonly OPEN = 1
      static readonly CLOSED = 2
      onopen: (() => void) | null = null
      onmessage: ((event: { data: string }) => void) | null = null
      onerror: (() => void) | null = null

      constructor(url: string) {
        // Two different channels reach this one constructor: the session-wide
        // collaboration hub (`/api/stream`) and — in the live variant — the
        // per-conversation frame relay opened by `useSpectatedTurn`. Branching on
        // the URL keeps the preview honest about which surface reads which.
        const isFrameRelay = url.endsWith('/live')
        setTimeout(() => {
          this.onopen?.()
          if (isFrameRelay) {
            this.replayFrames()
            return
          }
          // A turn in flight would contradict the hand-back variant (Piloti is
          // precisely NOT working there), so that variant only opens the channel.
          if (isHandbackVariant()) return
          this.emitEnvelope({
            kind: 'conversation.turn',
            conversationId: CONVERSATION_ID,
            phase: 'started',
            actorUserId: TOBIAS,
          })
          // Somebody at a keyboard, alongside the agent working — the two live
          // signals are independent, and the live variant shows both at once.
          //
          // Deliberately on a LATER timer than the turn event, and not merely for
          // realism (a colleague starts typing during a turn, not in the same
          // millisecond): the indicator resolves its names against the roster, so a
          // claim that lands before `GET /api/sharing/...` has answered is held
          // until it does. Firing both in one tick made the capture race that
          // fetch, which is a flaky screenshot rather than a product defect —
          // but a flaky screenshot is not evidence.
          if (isLiveVariant()) {
            setTimeout(
              () =>
                this.emitEnvelope({
                  kind: 'conversation.typing',
                  conversationId: CONVERSATION_ID,
                  userId: ANNA,
                  typing: true,
                  // Long enough to outlive the capture; the expiry itself is
                  // covered by the hook's unit tests, not by a picture.
                  ttlMs: 600_000,
                }),
              600
            )
          }
        }, 40)
      }

      private emitEnvelope(event: unknown): void {
        this.onmessage?.({ data: JSON.stringify({ id: 'preview-1', at: at(11), event }) })
      }

      /** Feed the spectator reducer the same frames the backend would publish. */
      private replayFrames(): void {
        LIVE_FRAMES.forEach((payload, index) => {
          setTimeout(
            () =>
              this.onmessage?.({
                data: JSON.stringify({ kind: 'frame', seq: index + 1, payload }),
              }),
            30 * (index + 1)
          )
        })
      }

      close(): void {}
      addEventListener(): void {}
      removeEventListener(): void {}
    }
    ;(window as unknown as { EventSource: unknown }).EventSource = PreviewEventSource
  }
}

/**
 * Puts the reader in the thread, as opening it would. The store starts EMPTY on
 * purpose: a shared thread's history comes from the server (ADR-0033), so the
 * preview proves the load path rather than dressing a local fixture.
 */
export function seedSharedThread(): void {
  useChatStore.setState({
    currentUserId: ME,
    currentConversation: {
      id: CONVERSATION_ID,
      userId: ANNA,
      projectId: 'dev',
      title: 'Brandschutz Stiegenhaus Nord',
      messages: [],
      createdAt: new Date(at(0)),
      updatedAt: new Date(at(11)),
    },
    conversations: [
      {
        id: CONVERSATION_ID,
        userId: ANNA,
        projectId: 'dev',
        title: 'Brandschutz Stiegenhaus Nord',
        messages: [],
        createdAt: new Date(at(0)),
        updatedAt: new Date(at(11)),
      },
    ],
    hasHydrated: true,
  })
}
