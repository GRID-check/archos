/**
 * The HTTP half of the A2A door (ADR-0123): which protocol version a request
 * speaks, and how an SDK answer becomes a response. Pure, so the route stays a
 * thin adapter and the specs reach these without a server.
 */

import { A2A_VERSION_HEADER, formatSSEEvent, SSE_HEADERS } from '@a2a-js/sdk'

/** Why Piloti's own door is refused at `/api/a2a`, in words its model can relay (the recursion lock). */
export const PILOTI_DOOR_REFUSAL =
  'Piloti cannot ask Piloti: the A2A door is for other agents, and a turn may not start another.'

/** JSON-RPC error codes the route answers itself (A2A specification 5.4, JSON-RPC 2.0). */
export const PARSE_ERROR = -32700
export const VERSION_NOT_SUPPORTED = -32009

/**
 * The protocol version a request speaks: `1.0`, `0.3`, or null for one this
 * server does not. Read from the `A2A-Version` header, else the query parameter
 * of that name; absent or empty is 0.3, as the specification says. The patch
 * number is ignored.
 */
export function protocolVersionOf(request: Request): '1.0' | '0.3' | null {
  const header = request.headers.get(A2A_VERSION_HEADER)
  const raw = (header ?? new URL(request.url).searchParams.get(A2A_VERSION_HEADER) ?? '').trim()
  if (raw === '') return '0.3'
  const [major, minor = '0'] = raw.split('.')
  if (major === '1' && minor === '0') return '1.0'
  if (major === '0' && minor === '3') return '0.3'
  return null
}

/** A JSON-RPC error the route answers before any method runs. */
export const jsonRpcErrorResponse = (code: number, message: string): Response =>
  Response.json({ jsonrpc: '2.0', id: null, error: { code, message } })

const isAsyncIterable = (value: unknown): value is AsyncGenerator<unknown, void, undefined> =>
  typeof value === 'object' && value !== null && Symbol.asyncIterator in value

/**
 * An SDK answer as HTTP: one JSON-RPC envelope as JSON, or a stream of them as
 * server-sent events (`data: <envelope>`), closed when the generator ends. A
 * client that goes away stops the generator, and with it the polling.
 */
export function jsonRpcResponse(result: unknown): Response {
  if (!isAsyncIterable(result)) return Response.json(result)
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await result.next()
        if (next.done) {
          controller.close()
          return
        }
        controller.enqueue(encoder.encode(formatSSEEvent(next.value)))
      } catch (error) {
        console.error('[a2a] the stream failed:', error)
        controller.close()
      }
    },
    async cancel() {
      await result.return(undefined)
    },
  })
  return new Response(stream, { headers: { ...SSE_HEADERS } })
}
