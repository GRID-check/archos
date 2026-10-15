/**
 * The chat socket's driver (docs/design/chat-wire-v2.md §e.2, §e.3), driven
 * through a mock socket that delivers the recorded v2 turns
 * (`shared/wire/v2/`) into the real store.
 */
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ClientMessage, WireEvent } from '@/adapters/api/wire-v2'
import type { TurnSocketOptions, TurnSocketStatus } from '@/adapters/api/turn-socket'
import { eventOf, frameOf, wireEvents } from '@/test-utils/wire-v2-fixtures'

const sockets = vi.hoisted(() => [] as Array<{ options: TurnSocketOptions; sent: unknown[]; open: boolean; offers: Set<string>; connect: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn>; reconnect: ReturnType<typeof vi.fn> }>)
vi.mock('@/adapters/api/turn-socket', () => ({
  createTurnSocket: (options: TurnSocketOptions) => {
    const socket = {
      options,
      sent: [] as unknown[],
      open: false,
      offers: new Set<string>(),
      connect: vi.fn(async () => {}),
      close: vi.fn(),
      reconnect: vi.fn(),
    }
    sockets.push(socket)
    return {
      connect: socket.connect,
      close: socket.close,
      reconnect: socket.reconnect,
      send: (message: unknown) => {
        if (!socket.open) return false
        if ((message as { type?: string }).type === 'steer' && !socket.offers.has('steer')) return false
        socket.sent.push(message)
        return true
      },
      accepts: (entry: string) => socket.open && socket.offers.has(entry),
    }
  },
}))
const posthogSessionId = vi.hoisted(() => vi.fn((): string | null => null))
vi.mock('@/lib/analytics/posthog', () => ({ getPosthogSessionId: posthogSessionId, capturePosthog: vi.fn() }))
vi.mock('@/adapters/auth', () => ({
  useAuth: () => ({ user: { id: 'user-1', name: 'Max' }, authRequired: false, isLoading: false }),
}))
vi.mock('@/i18n', () => ({ useTranslations: () => (key: string) => key, getActiveLocale: () => 'de' }))
vi.mock('@/shared/collaboration/thread-sharing', () => ({ useThreadSharing: () => 'private' }))
vi.mock('@/shared/hooks/use-backend-health', () => ({
  checkBackendHealthCached: vi.fn(async () => true),
  invalidateHealthCache: vi.fn(),
}))
vi.mock('@/features/layout/store', () => ({
  useLayoutStore: {
    getState: () => ({
      enabledDataSourceIds: ['web_search'],
      availableDataSources: [],
      knowledgeLayerAvailable: false,
      activeSourcePreset: null,
      setEnabledDataSources: vi.fn(),
    }),
  },
}))
vi.mock('@/features/documents/discard-session-resources', () => ({
  discardSessionDocumentsResources: vi.fn(),
}))
const runMessage = vi.hoisted(() => vi.fn())
vi.mock('../lib/commissioned-run', () => ({ fetchRunMessage: runMessage }))
const client = vi.hoisted(() => ({
  list: vi.fn().mockResolvedValue([]),
  get: vi.fn().mockResolvedValue(undefined),
  create: vi.fn().mockResolvedValue(undefined),
  listMessages: vi.fn().mockResolvedValue([]),
  createMessage: vi.fn().mockResolvedValue(undefined),
  updateMessageProvenance: vi.fn().mockResolvedValue(undefined),
  updateMessageStages: vi.fn().mockResolvedValue(undefined),
  updateMessagePromptState: vi.fn().mockResolvedValue(undefined),
  cutStoppedAnswer: vi.fn().mockResolvedValue(undefined),
  generateTitle: vi.fn().mockResolvedValue(undefined),
  newestFrameAge: vi.fn().mockResolvedValue(null),
}))
vi.mock('@/adapters/api/conversations-client', () => ({ conversationsClient: client }))

import { capturePosthog } from '@/lib/analytics/posthog'
import { useChatStore } from '../store'
import { useFilePreviewStore } from '@/features/documents/stores/file-preview-store'
import type { FileItem } from '@/features/documents/components/project-file-workspace'
import { ACK_TIMEOUT_MS, DELTA_FLUSH_MS, useWebSocketChat } from './use-websocket-chat'
import type { ChatMessage, Conversation } from '../types'

const conversationOf = (id: string, messages: ChatMessage[] = []): Conversation => ({
  id,
  userId: 'user-1',
  title: 'Fluchtweg',
  messages,
  createdAt: new Date('2026-09-25T09:00:00.000Z'),
  updatedAt: new Date('2026-09-25T09:00:00.000Z'),
})
const questionOf = (id: string): ChatMessage => ({
  id,
  role: 'user',
  content: 'Wie lang darf der Fluchtweg sein?',
  timestamp: new Date('2026-09-25T09:00:00.000Z'),
  messageType: 'user',
})

/** A recorded turn, as this conversation's turn `turnId`. */
const retarget = (events: WireEvent[], conversationId: string, turnId: string): WireEvent[] =>
  events.map((event) => ({ ...event, conversation_id: conversationId, turn_id: turnId }) as WireEvent)

const socket = () => sockets[sockets.length - 1]!
const status = (next: TurnSocketStatus) =>
  act(() => {
    socket().open = next === 'open'
    socket().options.onStatus?.(next)
  })
const deliver = (events: WireEvent[]) =>
  act(() => {
    for (const event of events) socket().options.onEvent(event)
  })
const sentOf = (type: ClientMessage['type']) =>
  socket().sent.filter((message) => (message as { type: string }).type === type) as Record<string, unknown>[]
const messages = () => useChatStore.getState().currentConversation!.messages

const open = (conversation: Conversation) => {
  useChatStore.setState({ conversations: [conversation], currentConversation: conversation })
  const hook = renderHook(() => useWebSocketChat())
  status('open')
  return hook
}

/**
 * A socket open on `events`' conversation, and the turn of those events just
 * sent from it: its question in the thread, its view begun.
 */
const openTurn = (events: WireEvent[]) => {
  const { conversation_id: conversationId, turn_id: turnId } = events[0]!
  const hook = open(conversationOf(conversationId))
  act(() => {
    const conversation = conversationOf(conversationId, [questionOf(turnId)])
    useChatStore.setState({ conversations: [conversation], currentConversation: conversation })
    useChatStore.getState().beginTurn(conversationId, turnId)
  })
  return hook
}

const answered = wireEvents('turn-answered.jsonl')
const CONVERSATION = answered[0]!.conversation_id

beforeEach(() => {
  vi.clearAllMocks()
  sockets.length = 0
  localStorage.clear()
  useChatStore.setState({
    currentUserId: 'user-1',
    conversations: [],
    currentConversation: null,
    turns: {},
    resumableTurn: null,
    isStreaming: false,
    isLoading: false,
    pendingInteraction: null,
    currentUserMessageId: null,
    composerDrafts: {},
    composerSubject: null,
  })
})
afterEach(() => vi.useRealTimers())

describe('a question', () => {
  it('goes out as a user_message whose id is the question, and again on every reopen until RUN_STARTED', () => {
    const { result } = open(conversationOf(CONVERSATION))

    act(() => void result.current.sendMessage('Wie lang darf der Fluchtweg sein?'))

    const question = messages().find((message) => message.messageType === 'user')!
    expect(sentOf('user_message')).toEqual([
      expect.objectContaining({ message_id: question.id, conversation_id: CONVERSATION, data_sources: ['web_search'] }),
    ])
    expect(useChatStore.getState()).toMatchObject({ isStreaming: true, isLoading: true })
    // Not acknowledged: not attached either, since the server may not have it.
    expect(socket().options.openTurns()).toEqual([])

    status('reconnecting')
    status('open')
    expect(sentOf('user_message')).toHaveLength(2)

    deliver(retarget(answered, CONVERSATION, question.id).slice(0, 1))
    expect(useChatStore.getState().isLoading).toBe(false)
    expect(socket().options.openTurns()).toEqual([{ turnId: question.id, lastSeq: 1 }])
    status('reconnecting')
    status('open')
    expect(sentOf('user_message')).toHaveLength(2)
  })

  it('records on its turn the Aufwand it was sent with, so the answer keeps it', () => {
    const { result } = open(conversationOf(CONVERSATION))

    act(() => void result.current.sendMessage('Wie lang darf der Fluchtweg sein?', { reasoningEffort: 'xhigh' }))

    const question = messages().find((message) => message.messageType === 'user')!
    expect(sentOf('user_message')[0]).toMatchObject({ reasoning_effort: 'xhigh' })
    expect(useChatStore.getState().turns[question.id]?.effort).toBe('xhigh')
  })

  it("sends the browser's PostHog session id with the turn, and leaves the key out while analytics is off", () => {
    const { result } = open(conversationOf(CONVERSATION))

    act(() => void result.current.sendMessage('Erste Frage'))
    expect(sentOf('user_message')[0]).not.toHaveProperty('posthog_session_id')

    posthogSessionId.mockReturnValueOnce('0199d7f2-5b3a-7c4e-9a1d-3e8f2b6c5d70')
    act(() => void result.current.sendMessage('Zweite Frage'))
    expect(sentOf('user_message')[1]).toMatchObject({ posthog_session_id: '0199d7f2-5b3a-7c4e-9a1d-3e8f2b6c5d70' })
  })

  it('tells PostHog a turn started, by its shape alone', () => {
    const { result } = open(conversationOf(CONVERSATION))

    act(() => void result.current.sendMessage('Wie lang darf der Fluchtweg sein?', { reasoningEffort: 'xhigh' }))

    expect(capturePosthog).toHaveBeenCalledTimes(1)
    expect(capturePosthog).toHaveBeenCalledWith('chat_message_sent', {
      has_attachments: false,
      effort: 'xhigh',
      data_source_count: 1,
    })
    // The question is never an event property.
    expect(JSON.stringify(vi.mocked(capturePosthog).mock.calls)).not.toContain('Fluchtweg')
  })

  it("does not make a file that is merely open in a peek the turn's focus", () => {
    const file = { id: 'doc-1', filename: 'Museum-Grundriss.pdf', displayName: null, fileSize: 1, contentType: 'application/pdf', status: 'ready', folderId: null, createdAt: '2026-01-01T00:00:00.000Z', errorMessage: null, summary: null, pageCount: null, chunkCount: null } as unknown as FileItem
    act(() => useFilePreviewStore.getState().open(file, 'peek'))
    const { result } = open(conversationOf(CONVERSATION))

    act(() => void result.current.sendMessage('Welche Absturzhöhe bei den Brüstungen?'))
    expect(sentOf('user_message')[0]).toMatchObject({ focus_file_name: null })

    act(() => useChatStore.setState({ composerSubject: { resourceId: 'doc-1', filename: 'Museum-Grundriss.pdf', shelf: 'project' } as never }))
    act(() => void result.current.sendMessage('Fass zusammen'))
    expect(sentOf('user_message')[1]).toMatchObject({ focus_file_name: 'Museum-Grundriss.pdf' })
  })

  it('is followed rather than asked again when the server already has it', () => {
    const { result } = open(conversationOf(CONVERSATION))
    act(() => void result.current.sendMessage('Frage'))
    const id = messages()[0]!.id

    deliver([eventOf({ v: 2, type: 'CUSTOM', name: 'rejected', conversation_id: CONVERSATION, turn_id: id, seq: 0, ts: 1, value: { of: 'user_message', code: 'duplicate_turn' } })])

    expect(sentOf('attach')).toEqual([{ type: 'attach', conversation_id: CONVERSATION, turn_id: id, after_seq: 0 }])
  })
})

describe('folding', () => {
  const TURN = answered[0]!.turn_id

  it('holds answer deltas for the flush, and flushes at once for anything else', () => {
    vi.useFakeTimers()
    openTurn(answered)

    deliver(answered.filter((event) => event.seq <= 13))
    const answerId = useChatStore.getState().turns[TURN]!.messageId!
    const bubble = () => messages().find((message) => message.id === answerId)
    expect(bubble()?.content ?? '').toBe('')
    act(() => void vi.advanceTimersByTime(DELTA_FLUSH_MS))
    expect(bubble()!.content).not.toBe('')

    deliver(answered.filter((event) => event.seq === 14 || event.seq === 15))
    // The card flushed the delta before it, without waiting.
    expect(bubble()!.cards?.[0]?.type).toBe('egress_diagram')
    expect(bubble()!.content).toBe(useChatStore.getState().turns[TURN]!.text)
  })

  it('attaches a gap from the last seq it folded, once', () => {
    openTurn(answered)

    deliver(answered.filter((event) => event.seq <= 3 || event.seq === 6 || event.seq === 7))

    expect(sentOf('attach')).toEqual([{ type: 'attach', conversation_id: CONVERSATION, turn_id: TURN, after_seq: 3 }])
  })

  it('keeps a finished turn attachable until its stages have landed', () => {
    openTurn(answered)

    deliver(answered.filter((event) => event.seq <= 20))
    expect(socket().options.openTurns()).toEqual([{ turnId: TURN, lastSeq: 20, settled: true }])

    deliver(answered.filter((event) => event.seq > 20))
    expect(socket().options.openTurns()).toEqual([])
  })
})

describe('reload mid-answer', () => {
  const TURN = answered[0]!.turn_id

  it('attaches the open question from its first event and rebuilds the answer from the replay', () => {
    const conversation = conversationOf(CONVERSATION, [questionOf(TURN)])
    useChatStore.setState({ conversations: [conversation], currentConversation: conversation })
    useChatStore.getState().restoreSessionState(conversation)
    renderHook(() => useWebSocketChat())
    expect(sentOf('attach')).toEqual([])

    status('open')

    expect(sentOf('attach')).toEqual([{ type: 'attach', conversation_id: CONVERSATION, turn_id: TURN, after_seq: 0 }])
    expect(useChatStore.getState()).toMatchObject({ isStreaming: true, resumableTurn: null })

    deliver(answered)
    const result = answered.find((event) => event.type === 'RUN_FINISHED')!
    expect(messages().at(-1)).toMatchObject({
      id: result.type === 'RUN_FINISHED' ? result.result.message_id : '',
      content: result.type === 'RUN_FINISHED' ? result.result.text : '',
    })
    expect(useChatStore.getState().isStreaming).toBe(false)
  })

  it('asks the server for the answer when the stream no longer holds the turn, and says so only when it has none', async () => {
    const conversation = conversationOf(CONVERSATION, [questionOf(TURN)])
    useChatStore.setState({ conversations: [conversation], currentConversation: conversation })
    useChatStore.getState().restoreSessionState(conversation)
    renderHook(() => useWebSocketChat())
    status('open')

    deliver([eventOf({ v: 2, type: 'CUSTOM', name: 'rejected', conversation_id: CONVERSATION, turn_id: TURN, seq: 0, ts: 1, value: { of: 'attach', code: 'turn_not_found' } })])

    expect(useChatStore.getState().isStreaming).toBe(false)
    await vi.waitFor(() =>
      expect(messages().at(-1)).toMatchObject({ messageType: 'error', errorData: { errorCode: 'agent.response_interrupted' } })
    )
  })
})

describe('switching conversations mid-turn', () => {
  const TURN = answered[0]!.turn_id

  it('closes the socket with the conversation and re-attaches the turn from its last seq on return', () => {
    const { rerender } = openTurn(answered)
    deliver(answered.filter((event) => event.seq <= 9))
    const first = socket()
    const b = conversationOf('conv-b')
    useChatStore.setState({ conversations: [useChatStore.getState().currentConversation!, b] })

    act(() => useChatStore.getState().selectConversation(b.id))
    rerender()
    expect(first.close).toHaveBeenCalled()
    expect(socket().options.conversationId).toBe('conv-b')
    expect(useChatStore.getState().isStreaming).toBe(false)

    act(() => useChatStore.getState().selectConversation(CONVERSATION))
    rerender()
    expect(socket().options.conversationId).toBe(CONVERSATION)
    expect(socket().options.openTurns()).toEqual([{ turnId: TURN, lastSeq: 9 }])
    expect(useChatStore.getState().isStreaming).toBe(true)
  })
})

describe('Stop', () => {
  const cancelled = wireEvents('turn-cancelled.jsonl')
  const TURN = cancelled[0]!.turn_id
  const CANCELLED_CONVERSATION = cancelled[0]!.conversation_id

  it('sends cancel_turn and keeps the partial answer that was drawn, marked stopped', () => {
    vi.useFakeTimers()
    openTurn(cancelled)
    deliver(cancelled.filter((event) => event.seq <= 4))
    act(() => void vi.advanceTimersByTime(DELTA_FLUSH_MS))
    const drawn = messages().find((message) => message.messageType === 'agent_response')!.content
    expect(drawn).not.toBe('')

    act(() => useChatStore.getState().stopStreaming())

    // With where the reader was: the socket leaves `shown` out for a server whose hello does not accept it.
    expect(sentOf('cancel_turn')).toEqual([
      {
        type: 'cancel_turn',
        conversation_id: CANCELLED_CONVERSATION,
        turn_id: TURN,
        shown: { seq: 4, chars: Array.from(drawn).length },
      },
    ])
    expect(useChatStore.getState().isStreaming).toBe(false)
    // Cut by the rule the server cuts its row by, which trims.
    expect(messages().find((message) => message.messageType === 'agent_response')).toMatchObject({
      content: drawn.trim(),
      stopped: true,
    })

    // The cancelled terminal carries the server's text; the answer keeps what was drawn.
    deliver(cancelled.filter((event) => event.seq === 5))
    const answer = messages().find((message) => message.messageType === 'agent_response')!
    expect(answer).toMatchObject({ stopped: true, content: drawn.trim() })
    vi.useRealTimers()
  })

  // A delta still waiting for its flush was never on screen: a Stop does not
  // add it, nor does a terminal that comes straight back.
  it('adds nothing that was not drawn at the press', () => {
    openTurn(cancelled)
    deliver(cancelled.filter((event) => event.seq <= 4))

    act(() => useChatStore.getState().stopStreaming())
    deliver(cancelled.filter((event) => event.seq === 5))

    expect(sentOf('cancel_turn')).toHaveLength(1)
    // Nothing was on screen, and the server is told so: it stores nothing either.
    expect(sentOf('cancel_turn')[0]).toMatchObject({ shown: { chars: 0 } })
    expect(messages().some((message) => message.messageType === 'agent_response')).toBe(false)
    expect(useChatStore.getState().turns[TURN]).toMatchObject({ outcome: 'cancelled', text: '' })
  })

  // The server had finished before the Stop reached it, and this page never
  // folded its terminal: the answer on screen is stored, and the server's
  // whole row is cut to it.
  it('keeps the stopped answer when the server answers the Stop with turn_not_found', async () => {
    vi.useFakeTimers()
    openTurn(cancelled)
    deliver(cancelled.filter((event) => event.seq <= 4))
    act(() => void vi.advanceTimersByTime(DELTA_FLUSH_MS))
    const answer = messages().find((message) => message.messageType === 'agent_response')!
    const drawn = answer.content
    act(() => useChatStore.getState().stopStreaming())
    vi.useRealTimers()

    deliver([
      eventOf({
        v: 2,
        type: 'CUSTOM',
        name: 'rejected',
        conversation_id: CANCELLED_CONVERSATION,
        turn_id: TURN,
        seq: 0,
        ts: 1,
        value: { of: 'cancel_turn', code: 'turn_not_found' },
      }),
    ])

    await vi.waitFor(() =>
      expect(client.cutStoppedAnswer).toHaveBeenCalledWith(CANCELLED_CONVERSATION, answer.id, { turnId: TURN, shown: drawn })
    )
    expect(useChatStore.getState().turns[TURN]).toBeUndefined()
    expect(messages().find((message) => message.id === answer.id)).toMatchObject({ stopped: true, content: drawn.trim() })
  })
})

describe('a question for the asker', () => {
  const hitl = wireEvents('turn-hitl-handoff.jsonl')
  const TURN = hitl[0]!.turn_id
  const HITL_CONVERSATION = hitl[0]!.conversation_id

  it("answers a choice with the option's id, and follows the run the turn hands off to", async () => {
    const { result } = openTurn(hitl)
    deliver(hitl.filter((event) => event.seq <= 4))
    expect(result.current.pendingInteraction).toEqual({ turnId: TURN, interactionId: 'ask_01J9Z6', input: 'choice' })

    act(() => result.current.respondToInteraction('1'))

    expect(sentOf('interaction_response')).toEqual([
      {
        type: 'interaction_response',
        conversation_id: HITL_CONVERSATION,
        turn_id: TURN,
        interaction_id: 'ask_01J9Z6',
        answer: { option_id: '1' },
      },
    ])
    expect(messages().find((message) => message.messageType === 'prompt')).toMatchObject({
      isPromptResponded: true,
      promptResponse: '1',
    })

    runMessage.mockResolvedValue(null)
    deliver(hitl.filter((event) => event.seq > 4))
    const finish = hitl.find((event) => event.type === 'RUN_FINISHED')!
    const runMessageId = finish.type === 'RUN_FINISHED' ? finish.result.run!.run_message_id : ''
    expect(runMessage).toHaveBeenCalledWith(HITL_CONVERSATION, runMessageId)
  })
})

describe('the socket', () => {
  it('asks for a reload when the server speaks a newer wire (4426)', () => {
    open(conversationOf(CONVERSATION))
    status('outdated')
    expect(messages().at(-1)).toMatchObject({ errorData: { errorCode: 'connection.client_outdated' } })
  })

  it('reconnects on auth_expired and sends the refused question again', () => {
    const { result } = open(conversationOf(CONVERSATION))
    act(() => void result.current.sendMessage('Frage'))
    const id = messages()[0]!.id

    deliver([eventOf({ v: 2, type: 'CUSTOM', name: 'rejected', conversation_id: CONVERSATION, turn_id: id, seq: 0, ts: 1, value: { of: 'user_message', code: 'auth_expired' } })])
    expect(socket().close).toHaveBeenCalled()
    expect(socket().connect).toHaveBeenCalledTimes(2)

    status('open')
    expect(sentOf('user_message').map((message) => message.message_id)).toEqual([id, id])
  })

  it('ends a failed turn with its banner once the server has no answer for it', async () => {
    const failed = wireEvents('turn-error.jsonl')
    const TURN = failed[0]!.turn_id
    openTurn(failed)

    deliver(failed)

    expect(useChatStore.getState().turns[TURN]).toBeUndefined()
    await vi.waitFor(() =>
      expect(messages().at(-1)).toMatchObject({ messageType: 'error', errorData: { errorCode: 'agent.workflow_error' } })
    )
  })
})

describe('nothing waits on silence', () => {
  const TURN = answered[0]!.turn_id
  const rejection = (turnId: string, of: string, code: string) =>
    eventOf({ v: 2, type: 'CUSTOM', name: 'rejected', conversation_id: CONVERSATION, turn_id: turnId, seq: 0, ts: 1, value: { of, code } })
  const lastError = () => messages().filter((message) => message.messageType === 'error').at(-1)

  it('ends a question the server never answers with an error the reader can retry, not a spinner', async () => {
    vi.useFakeTimers()
    const { result } = open(conversationOf(CONVERSATION))
    act(() => void result.current.sendMessage('Wie lang darf der Fluchtweg sein?'))
    expect(useChatStore.getState().isLoading).toBe(true)

    // First miss: the socket that did not answer is reopened, and the question goes out again.
    act(() => void vi.advanceTimersByTime(ACK_TIMEOUT_MS))
    expect(socket().reconnect).toHaveBeenCalledOnce()
    status('reconnecting')
    status('open')
    expect(sentOf('user_message')).toHaveLength(2)

    // Second miss: the turn ends, visibly.
    act(() => void vi.advanceTimersByTime(ACK_TIMEOUT_MS))
    expect(useChatStore.getState()).toMatchObject({ isLoading: false, isStreaming: false })
    await vi.waitFor(() => expect(lastError()).toMatchObject({ errorData: { errorCode: 'agent.no_response' } }))

    // And it is not asked again behind the reader's back.
    status('reconnecting')
    status('open')
    expect(sentOf('user_message')).toHaveLength(2)
  })

  it('reopens nothing for a question the server acknowledged', () => {
    vi.useFakeTimers()
    const { result } = open(conversationOf(CONVERSATION))
    act(() => void result.current.sendMessage('Frage'))
    const id = messages()[0]!.id
    deliver(retarget(answered, CONVERSATION, id).slice(0, 1))

    act(() => void vi.advanceTimersByTime(10 * ACK_TIMEOUT_MS))

    expect(socket().reconnect).not.toHaveBeenCalled()
    expect(useChatStore.getState().isStreaming).toBe(true)
    expect(lastError()).toBeUndefined()
  })

  it('takes any answer as a sign the socket works: a refusal restarts the deadline', () => {
    vi.useFakeTimers()
    const { result } = open(conversationOf(CONVERSATION))
    act(() => void result.current.sendMessage('Frage'))
    const id = messages()[0]!.id

    act(() => void vi.advanceTimersByTime(ACK_TIMEOUT_MS - 1))
    deliver([rejection(id, 'user_message', 'auth_expired')])
    act(() => void vi.advanceTimersByTime(ACK_TIMEOUT_MS - 1))

    expect(socket().reconnect).not.toHaveBeenCalled()
  })

  it('opens a new socket for a question asked after the last one gave up', async () => {
    const { result } = open(conversationOf(CONVERSATION))
    status('failed')
    // The explanation is asynchronous; let it land here, not in the next test's thread.
    await vi.waitFor(() => expect(lastError()).toMatchObject({ errorData: { errorCode: 'connection.failed' } }))
    const connects = socket().connect.mock.calls.length

    act(() => void result.current.sendMessage('Noch einmal'))

    expect(socket().connect.mock.calls.length).toBe(connects + 1)
  })

  it('asks the first question of a new chat, and does not attach it instead', () => {
    useChatStore.setState({ conversations: [], currentConversation: null })
    const { result, rerender } = renderHook(() => useWebSocketChat())

    act(() => void result.current.sendMessage('Was weißt du über die OIB 2?'))
    rerender()
    const question = messages().find((message) => message.messageType === 'user')!

    expect(sockets).toHaveLength(1)
    expect(socket().close).not.toHaveBeenCalled()
    status('open')
    expect(sentOf('user_message')).toEqual([expect.objectContaining({ message_id: question.id })])
    expect(sentOf('attach')).toEqual([])
  })

  it('does not ask a question again that was stopped before the server acknowledged it', () => {
    const { result } = open(conversationOf(CONVERSATION))
    act(() => void result.current.sendMessage('Frage'))

    act(() => useChatStore.getState().stopStreaming())
    status('reconnecting')
    status('open')

    expect(sentOf('user_message')).toHaveLength(1)
    expect(sentOf('cancel_turn')).toHaveLength(1)
  })

  it('ends a running turn found silent on two sockets in a row, and asks the server first', async () => {
    openTurn(answered)
    deliver(answered.filter((event) => event.seq <= 3))

    act(() => socket().options.onSilent?.([TURN]))
    // Something of the turn in between: it lives, and the count starts over.
    deliver(answered.filter((event) => event.seq === 4))
    act(() => socket().options.onSilent?.([TURN]))
    expect(useChatStore.getState().isStreaming).toBe(true)

    act(() => socket().options.onSilent?.([TURN]))
    expect(useChatStore.getState().isStreaming).toBe(false)
    await vi.waitFor(() => expect(lastError()).toMatchObject({ errorData: { errorCode: 'agent.response_interrupted' } }))
  })

  it('ends a turn whose resume the server refused as invalid, like one it no longer holds', async () => {
    const conversation = conversationOf(CONVERSATION, [questionOf(TURN)])
    useChatStore.setState({ conversations: [conversation], currentConversation: conversation })
    useChatStore.getState().restoreSessionState(conversation)
    renderHook(() => useWebSocketChat())
    status('open')

    deliver([rejection(TURN, 'attach', 'invalid_message')])

    expect(useChatStore.getState().isStreaming).toBe(false)
    await vi.waitFor(() => expect(lastError()).toMatchObject({ errorData: { errorCode: 'agent.response_interrupted' } }))
  })

  it('says the server is incompatible, not the network, and ends the turn that was waiting', async () => {
    const { result } = open(conversationOf(CONVERSATION))
    act(() => void result.current.sendMessage('Frage'))

    status('incompatible')

    expect(messages().some((message) => message.errorData?.errorCode === 'connection.server_incompatible')).toBe(true)
    expect(messages().some((message) => message.errorData?.errorCode === 'connection.failed')).toBe(false)
    expect(useChatStore.getState().isStreaming).toBe(false)
  })
})


describe('steering the running turn', () => {
  const steered = wireEvents('turn-steered.jsonl')
  const STEERED_CONVERSATION = steered[0]!.conversation_id
  const TURN = steered[0]!.turn_id
  const started = steered.filter((event) => event.seq === 1)
  const custom = (seq: number, name: string, value: Record<string, unknown>) =>
    eventOf(frameOf(seq, { type: 'CUSTOM', name, value }, TURN)) as WireEvent
  const finished = (seq: number, outcome = 'answered') =>
    ({ ...eventOf(frameOf(seq, { type: 'RUN_FINISHED', outcome, result: { message_id: 'a', text: 'Fertig.' } }, TURN)), conversation_id: STEERED_CONVERSATION }) as WireEvent
  const inConversation = (event: WireEvent) => ({ ...event, conversation_id: STEERED_CONVERSATION }) as WireEvent

  const steering = () => {
    const hook = openTurn(steered)
    socket().offers.add('steer')
    status('open')
    deliver(started)
    return hook
  }

  it('sends a note for the running turn when the server reads notes, and says so', () => {
    const { result } = steering()
    expect(result.current.canSteer).toBe(true)

    let taken = false
    act(() => void (taken = result.current.steer({ text: 'nicht die Tür, die Treppe' })))

    expect(taken).toBe(true)
    expect(sentOf('steer')).toEqual([
      expect.objectContaining({ conversation_id: STEERED_CONVERSATION, turn_id: TURN, text: 'nicht die Tür, die Treppe' }),
    ])
    expect(sentOf('user_message')).toHaveLength(0)
  })

  it('offers nothing to a server that reads no notes: the text stays with the reader', () => {
    const { result } = openTurn(steered)
    deliver(started)

    expect(result.current.canSteer).toBe(false)
    let taken = true
    act(() => void (taken = result.current.steer({ text: 'die Treppe' })))
    expect(taken).toBe(false)
    expect(sentOf('steer')).toEqual([])
  })

  it('asks a note the turn never read as the next question, once the turn has ended', async () => {
    vi.useFakeTimers()
    const { result } = steering()
    act(() => void result.current.steer({ text: 'und das Podest?' }))
    const [note] = sentOf('steer')
    deliver([inConversation(custom(2, 'steer_received', { steer_id: note!.steer_id, text: 'und das Podest?' })), finished(3)])
    await act(async () => void (await vi.advanceTimersByTimeAsync(1)))

    expect(sentOf('user_message').at(-1)).toMatchObject({ text: 'und das Podest?' })
    vi.useRealTimers()
  })

  it('asks nothing again for a note the turn read', async () => {
    vi.useFakeTimers()
    const { result } = steering()
    act(() => void result.current.steer({ text: 'die Treppe' }))
    const [note] = sentOf('steer')
    deliver([
      inConversation(custom(2, 'steer_received', { steer_id: note!.steer_id, text: 'die Treppe' })),
      inConversation(custom(3, 'steer_applied', { steer_id: note!.steer_id, round: 2 })),
      finished(4),
    ])
    await act(async () => void (await vi.advanceTimersByTimeAsync(1)))

    expect(sentOf('user_message')).toHaveLength(0)
    const view = useChatStore.getState().turns[TURN]!
    expect(view.steers?.[String(note!.steer_id)]).toEqual({ text: 'die Treppe', round: 2 })
    vi.useRealTimers()
  })

  it('drops an unread note when the asker stopped the turn', async () => {
    vi.useFakeTimers()
    const { result } = steering()
    act(() => void result.current.steer({ text: 'die Treppe' }))
    deliver([finished(2, 'cancelled')])
    await act(async () => void (await vi.advanceTimersByTimeAsync(1)))

    expect(sentOf('user_message')).toHaveLength(0)
    vi.useRealTimers()
  })

  it('keeps the turn running when the server refuses a note, and asks the note once the turn ends', async () => {
    vi.useFakeTimers()
    const { result } = steering()
    act(() => void result.current.steer({ text: 'die Treppe' }))
    deliver([inConversation(eventOf({ ...frameOf(0, { type: 'CUSTOM', name: 'rejected', value: { of: 'steer', code: 'steer_limit' } }, TURN) }))])
    expect(useChatStore.getState().turns[TURN]?.phase).toBe('running')

    deliver([finished(2)])
    await act(async () => void (await vi.advanceTimersByTimeAsync(1)))
    expect(sentOf('user_message').at(-1)).toMatchObject({ text: 'die Treppe' })
    vi.useRealTimers()
  })
})

describe('a phone away: locked, offline, or a network that gave up', () => {
  const TURN = answered[0]!.turn_id
  const ANSWER_ID = answered[0]!.type === 'RUN_STARTED' ? answered[0]!.message_id : ''
  /** Up to the card: the answer's first two sentences are on screen, the turn still runs. */
  const halfway = answered.filter((event) => event.seq <= 15)
  const answerRow = () => messages().find((message) => message.id === ANSWER_ID)
  const lastError = () => messages().filter((message) => message.messageType === 'error').at(-1)
  const notFound = () =>
    eventOf({ v: 2, type: 'CUSTOM', name: 'rejected', conversation_id: CONVERSATION, turn_id: TURN, seq: 0, ts: 1, value: { of: 'attach', code: 'turn_not_found' } })
  const serverRow = (id: string, role: 'user' | 'assistant', content: string) => ({
    id,
    conversationId: CONVERSATION,
    role,
    content,
    metadata: { messageType: role === 'user' ? 'user' : 'agent_response' },
    createdAt: '2026-09-25T09:01:00.000Z',
  })
  const setVisibility = (state: DocumentVisibilityState) =>
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state })

  afterEach(() => {
    setVisibility('visible')
    client.listMessages.mockResolvedValue([])
  })

  it('keeps a running turn and its words when the socket gives up on the network, and attaches it again', async () => {
    openTurn(answered)
    deliver(halfway)
    const shown = answerRow()?.content
    expect(shown).toBeTruthy()

    status('failed')
    await vi.waitFor(() => expect(lastError()).toMatchObject({ errorData: { errorCode: 'connection.failed' } }))

    expect(useChatStore.getState().turns[TURN]?.phase).toBe('running')
    expect(answerRow()?.content).toBe(shown)
    expect(client.listMessages).not.toHaveBeenCalled()
    expect(socket().options.openTurns()).toEqual([{ turnId: TURN, lastSeq: 15 }])

    // The socket that opens again attaches it; the rest of the answer folds on.
    status('open')
    deliver(answered.filter((event) => event.seq > 15))
    expect(useChatStore.getState().turns[TURN]?.phase).not.toBe('running')
    expect(messages().some((message) => message.errorData?.errorCode === 'agent.response_interrupted')).toBe(false)
  })

  it('keeps the words on screen while the server is asked, and puts the stored answer in their row', async () => {
    client.listMessages.mockResolvedValue([
      serverRow(TURN, 'user', 'Wie lang darf der Fluchtweg sein?'),
      serverRow(ANSWER_ID, 'assistant', 'Die ganze Antwort, wie der Server sie gespeichert hat.'),
    ])
    openTurn(answered)
    deliver(halfway)
    const at = messages().findIndex((message) => message.id === ANSWER_ID)

    deliver([notFound()])
    // Not dropped before the server has answered.
    expect(answerRow()?.content).toBeTruthy()

    await vi.waitFor(() => expect(answerRow()?.content).toBe('Die ganze Antwort, wie der Server sie gespeichert hat.'))
    expect(messages().findIndex((message) => message.id === ANSWER_ID)).toBe(at)
    expect(useChatStore.getState().turns[TURN]).toBeUndefined()
    expect(lastError()).toBeUndefined()
  })

  it('says the answer is lost only when the server confirms it has none, and keeps what was read, dimmed', async () => {
    client.listMessages.mockResolvedValue([])
    openTurn(answered)
    deliver(halfway)
    const shown = answerRow()?.content

    deliver([notFound()])

    await vi.waitFor(() => expect(lastError()).toMatchObject({ errorData: { errorCode: 'agent.response_interrupted' } }))
    expect(answerRow()).toMatchObject({ content: shown, failed: true })
    expect(answerRow()?.isStreaming).toBeUndefined()
  })

  it('counts no missed acknowledgement while the page is hidden', () => {
    vi.useFakeTimers()
    const { result } = open(conversationOf(CONVERSATION))
    act(() => void result.current.sendMessage('Frage'))

    setVisibility('hidden')
    act(() => void vi.advanceTimersByTime(4 * ACK_TIMEOUT_MS))

    expect(socket().reconnect).not.toHaveBeenCalled()
    expect(useChatStore.getState().isLoading).toBe(true)
    expect(lastError()).toBeUndefined()
  })

  it('counts no missed acknowledgement for a deadline that slept through a freeze', () => {
    vi.useFakeTimers()
    const { result } = open(conversationOf(CONVERSATION))
    act(() => void result.current.sendMessage('Frage'))

    vi.setSystemTime(Date.now() + 10 * 60_000)
    act(() => void vi.advanceTimersByTime(ACK_TIMEOUT_MS))

    expect(socket().reconnect).not.toHaveBeenCalled()
    // Back for real: the deadline runs again from now, and counts.
    act(() => void vi.advanceTimersByTime(ACK_TIMEOUT_MS))
    expect(socket().reconnect).toHaveBeenCalledOnce()
  })

  it('says once, in the status dock, that the connection is down while offline, until a socket opens', () => {
    openTurn(answered)
    deliver(halfway)

    status('offline')
    status('offline')

    const lostCards = () => messages().filter((message) => message.errorData?.errorCode === 'connection.lost')
    expect(lostCards()).toHaveLength(1)
    expect(useChatStore.getState().turns[TURN]?.phase).toBe('running')

    status('open')
    expect(lostCards()).toHaveLength(0)
  })
})
