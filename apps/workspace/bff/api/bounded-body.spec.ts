/**
 * @vitest-environment node
 */
/** A body past its cap is a 413, whether it declares its length or streams it. */

import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { readBoundedText } from './bounded-body'
import { BadRequestError, PayloadTooLargeError } from './errors'
import { parseJsonBody } from './handler'

const streamed = (text: string) =>
  new Request('http://x.test/', {
    method: 'POST',
    body: new ReadableStream({
      start(controller) {
        for (const chunk of text.match(/[^]{1,100}/g) ?? []) controller.enqueue(new TextEncoder().encode(chunk))
        controller.close()
      },
    }),
    duplex: 'half',
  } as RequestInit)

describe('readBoundedText', () => {
  it('reads a body inside the cap', async () => {
    await expect(readBoundedText(new Request('http://x.test/', { method: 'POST', body: 'hallo' }), 10)).resolves.toBe('hallo')
  })

  it('refuses a declared length past the cap before reading', async () => {
    const request = new Request('http://x.test/', { method: 'POST', body: 'x', headers: { 'content-length': '5000' } })
    await expect(readBoundedText(request, 1000)).rejects.toBeInstanceOf(PayloadTooLargeError)
  })

  it('refuses a streamed body once it crosses the cap', async () => {
    await expect(readBoundedText(streamed('x'.repeat(2_000)), 1_000)).rejects.toBeInstanceOf(PayloadTooLargeError)
    await expect(readBoundedText(streamed('x'.repeat(900)), 1_000)).resolves.toHaveLength(900)
  })
})

describe('parseJsonBody with maxBytes', () => {
  const schema = z.object({ a: z.number() })
  it('parses inside the cap, 413s past it, and 400s on bad JSON', async () => {
    await expect(parseJsonBody(streamed('{"a":1}'), schema, { maxBytes: 100 })).resolves.toEqual({ a: 1 })
    await expect(parseJsonBody(streamed(`{"a":1,"b":"${'x'.repeat(200)}"}`), schema, { maxBytes: 100 })).rejects.toBeInstanceOf(
      PayloadTooLargeError
    )
    await expect(parseJsonBody(streamed('{nope'), schema, { maxBytes: 100 })).rejects.toBeInstanceOf(BadRequestError)
  })
})
