/**
 * @vitest-environment node
 */
/**
 * The BFF's own chat-socket client (ADR-0106): it sends the question only to
 * a server that reads `if_idle`, and reads what became of it. The driver
 * underneath is the store-free `createTurnSocket`; here a fake stands in for
 * it, so the test plays the server's hello and frames.
 */

import { describe, expect, it, vi } from 'vitest'
import type { TurnSocket, TurnSocketOptions, TurnSocketStatus } from '@/adapters/api/turn-socket'
import type { ClientMessage } from '@/adapters/api/wire-v2'
import { eventOf, frameOf } from '@/test-utils/wire-v2-fixtures'
import { cancelHeadlessTurn, chatSocketUrl, runHeadlessTurn, type HeadlessUserMessage } from './headless-turn'

const MESSAGE: HeadlessUserMessage = {
  type: 'user_message',
  conversation_id: 's_thread',
  message_id: 'turn-1',
  text: 'Stimmt die Breite?',
  trigger: { kind: 'thread_mention', event_id: 'reply-1', annotation_id: 'ann-1' },
  if_idle: true,
}

const REQUIRES = ['user_message.trigger', 'user_message.if_idle']

/** A server played by the test: its hello's `accepts`, and the frames it answers with. */
function fakeServer(accepts: readonly string[]) {
  const sent: ClientMessage[] = []
  let options: TurnSocketOptions | null = null
  let closed = false
  const socket: TurnSocket = {
    connect: async () => options?.onStatus?.('open'),
    send: (message) => {
      sent.push(message)
      return true
    },
    accepts: (entry) => accepts.includes(entry),
    reconnect: () => {},
    close: () => {
      closed = true
    },
  }
  return {
    sent,
    closed: () => closed,
    options: () => options,
    createSocket: (given: TurnSocketOptions) => {
      options = given
      return socket
    },
    frame: (seq: number, body: Record<string, unknown>) => options?.onEvent(eventOf(frameOf(seq, body, 'turn-1'))),
    status: (status: TurnSocketStatus) => options?.onStatus?.(status),
  }
}

const run = (server: ReturnType<typeof fakeServer>, extra: { detachAfterMs?: number } = {}) =>
  runHeadlessTurn({
    url: 'ws://aiq-agent:8000/websocket',
    conversationId: 's_thread',
    headers: { 'x-grid-mode': 'headless' },
    message: MESSAGE,
    requires: REQUIRES,
    createSocket: server.createSocket,
    detachAfterMs: extra.detachAfterMs ?? 5,
  })

describe('runHeadlessTurn', () => {
  it('sends the question once the server said it reads it, and detaches after the turn started', async () => {
    const server = fakeServer(REQUIRES)
    const outcome = run(server)
    await vi.waitFor(() => expect(server.sent).toEqual([MESSAGE]))
    expect(server.options()?.openTurns()).toEqual([])

    server.frame(1, { type: 'RUN_STARTED', message_id: 'answer-1' })

    await expect(outcome).resolves.toEqual({ kind: 'started' })
    expect(server.closed()).toBe(true)
  })

  it('does not send to a server that would supersede a running turn (no if_idle)', async () => {
    const server = fakeServer(['user_message.trigger'])

    await expect(run(server)).resolves.toEqual({
      kind: 'unavailable',
      reason: 'the server does not read user_message.if_idle',
    })
    expect(server.sent).toEqual([])
  })

  it('reads busy, duplicate_turn and a refusal of the message', async () => {
    for (const [code, expected] of [
      ['busy', { kind: 'busy' }],
      ['duplicate_turn', { kind: 'duplicate' }],
      ['invalid_message', { kind: 'rejected', code: 'invalid_message', message: 'unknown field' }],
    ] as const) {
      const server = fakeServer(REQUIRES)
      const outcome = run(server)
      await vi.waitFor(() => expect(server.sent).toHaveLength(1))
      server.frame(0, { type: 'CUSTOM', name: 'rejected', value: { of: 'user_message', code, message: 'unknown field' } })
      await expect(outcome).resolves.toEqual(expected)
    }
  })

  it('reads a refused turn (admission, the budget) before it detaches', async () => {
    const server = fakeServer(REQUIRES)
    const outcome = run(server, { detachAfterMs: 1_000 })
    await vi.waitFor(() => expect(server.sent).toHaveLength(1))

    server.frame(1, { type: 'RUN_STARTED', message_id: 'answer-1' })
    server.frame(2, {
      type: 'RUN_FINISHED',
      outcome: 'refused',
      result: { message_id: 'answer-1', text: 'Das Budget ist aufgebraucht.' },
    })

    await expect(outcome).resolves.toEqual({ kind: 'refused', reason: 'Das Budget ist aufgebraucht.' })
  })

  it('reports a socket that never reached a server as unavailable', async () => {
    const server = fakeServer(REQUIRES)
    server.createSocket = (given) => {
      queueMicrotask(() => given.onStatus?.('failed'))
      return { connect: async () => {}, send: () => false, accepts: () => false, reconnect: () => {}, close: () => {} }
    }

    await expect(run(server)).resolves.toEqual({ kind: 'unavailable', reason: 'socket failed' })
  })
})

const cancel = (server: ReturnType<typeof fakeServer>, extra: { graceMs?: number } = {}) =>
  cancelHeadlessTurn({
    url: 'ws://aiq-agent:8000/websocket',
    conversationId: 's_thread',
    turnId: 'turn-1',
    headers: { 'x-grid-mode': 'headless' },
    createSocket: server.createSocket,
    graceMs: extra.graceMs ?? 5,
  })

describe('cancelHeadlessTurn', () => {
  it('sends one cancel_turn for the turn in its conversation, and reports the stop sent when nothing refuses it', async () => {
    const server = fakeServer([])
    const outcome = cancel(server)

    await vi.waitFor(() => expect(server.sent).toHaveLength(1))
    expect(server.sent[0]).toEqual({ type: 'cancel_turn', conversation_id: 's_thread', turn_id: 'turn-1' })
    expect(server.options()?.openTurns()).toEqual([])
    await expect(outcome).resolves.toEqual({ kind: 'sent' })
    expect(server.closed()).toBe(true)
  })

  it('reads a turn that is not running as good news, and any other refusal as one', async () => {
    for (const [code, expected] of [
      ['turn_not_found', { kind: 'not_running' }],
      ['not_asker', { kind: 'rejected', code: 'not_asker', message: 'nope' }],
    ] as const) {
      const server = fakeServer([])
      const outcome = cancel(server, { graceMs: 1_000 })
      await vi.waitFor(() => expect(server.sent).toHaveLength(1))

      server.frame(0, { type: 'CUSTOM', name: 'rejected', value: { of: 'cancel_turn', code, message: 'nope' } })

      await expect(outcome).resolves.toEqual(expected)
    }
  })

  it('ignores a refusal of something else, and another turn’s frames', async () => {
    const server = fakeServer([])
    const outcome = cancel(server)
    await vi.waitFor(() => expect(server.sent).toHaveLength(1))

    server.frame(0, { type: 'CUSTOM', name: 'rejected', value: { of: 'steer', code: 'turn_not_found', message: null } })
    server.options()?.onEvent(
      eventOf(frameOf(0, { type: 'CUSTOM', name: 'rejected', value: { of: 'cancel_turn', code: 'not_asker', message: null } }, 'turn-2'))
    )

    await expect(outcome).resolves.toEqual({ kind: 'sent' })
  })

  it('reports the stop sent as soon as the turn ends on the socket', async () => {
    const server = fakeServer([])
    const outcome = cancel(server, { graceMs: 60_000 })
    await vi.waitFor(() => expect(server.sent).toHaveLength(1))

    server.frame(3, { type: 'RUN_FINISHED', outcome: 'cancelled', result: { message_id: 'answer-1', text: '' } })

    await expect(outcome).resolves.toEqual({ kind: 'sent' })
  })

  it('reports a socket that never reached a server, or would not take the stop, as unavailable', async () => {
    const failed = fakeServer([])
    failed.createSocket = (given) => {
      queueMicrotask(() => given.onStatus?.('failed'))
      return { connect: async () => {}, send: () => false, accepts: () => false, reconnect: () => {}, close: () => {} }
    }
    await expect(cancel(failed)).resolves.toEqual({ kind: 'unavailable', reason: 'socket failed' })

    const refusing = fakeServer([])
    refusing.createSocket = (given) => ({
      connect: async () => given.onStatus?.('open'),
      send: () => false,
      accepts: () => false,
      reconnect: () => {},
      close: () => {},
    })
    await expect(cancel(refusing)).resolves.toEqual({
      kind: 'unavailable',
      reason: 'the socket would not take the stop',
    })
  })
})

describe('chatSocketUrl', () => {
  it('dials the chat role as server.js does: the Service, or with affinity the conversation’s pod', () => {
    expect(chatSocketUrl('s_conv', { BACKEND_CHAT_URL: 'http://aiq-agent:8000/' })).toBe('ws://aiq-agent:8000/websocket')
    expect(
      chatSocketUrl('s_conv', {
        BACKEND_CHAT_URL: 'http://aiq-agent:8000',
        BACKEND_REPLICAS: '3',
        BACKEND_POD_WS_TEMPLATE: 'ws://aiq-agent-{i}.aiq-agent-headless:8000',
      })
    ).toMatch(/^ws:\/\/aiq-agent-[0-2]\.aiq-agent-headless:8000\/websocket$/)
    expect(() => chatSocketUrl('s_conv', {})).toThrow(/BACKEND_CHAT_URL/)
  })
})
