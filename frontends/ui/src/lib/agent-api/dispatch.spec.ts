/**
 * @vitest-environment node
 */
/**
 * The dispatcher's bytes: binary answers out (inline, too large, redirect) and
 * the two upload encodings in (multipart form, raw octet-stream). The routes
 * here are stand-ins that echo what they received; the real upload routes are
 * held to the same form by their own `agent-upload.spec.ts`.
 */
import { describe, expect, it } from 'vitest'
import {
  MAX_INLINE_BYTES,
  MAX_TEXT_BYTES,
  callOperation,
  filenameFromDisposition,
  formDataOf,
  isBinaryBody,
  isOversizedBody,
  isRedirectBody,
} from './dispatch'
import { findOperation } from './catalog'
import type { AgentOperation, RouteHandler } from './operation'
import { MAX_UPLOAD_BYTES, rawBodySchema, uploadBodySchema, uploadBodySchemaWith } from './upload-wire'
import { z } from 'zod'

const session = {
  userId: 'user_1',
  email: 'a@piloti.test',
  name: null,
  accessToken: '',
  organizationId: 'org_1',
  organizationMembershipId: 'om_1',
  role: 'admin' as const,
  permissions: [],
  featureFlags: null,
}

function operation(handler: RouteHandler, extra: Partial<AgentOperation> = {}): AgentOperation {
  return {
    name: 'test-operation',
    domain: 'documents',
    summary: 'A test operation',
    description: 'An operation the dispatcher spec calls with a stand-in route.',
    method: 'GET',
    path: '/api/test',
    load: async () => ({ GET: handler, POST: handler, PUT: handler }),
    ...extra,
  }
}

const bytesOf = (text: string) => new TextEncoder().encode(text)
const base64Of = (text: string) => Buffer.from(text).toString('base64')

describe('a binary answer', () => {
  it('comes back as base64 with its type, size and file name', async () => {
    const op = operation(
      async () =>
        new Response(bytesOf('%PDF-1.7 fake'), {
          headers: {
            'content-type': 'application/pdf',
            'content-disposition': `attachment; filename="plan.pdf"; filename*=UTF-8''Grundri%C3%9F.pdf`,
          },
        }),
    )
    const result = await callOperation(op, {}, session)
    expect(result.ok).toBe(true)
    expect(result.body).toEqual({
      binary: true,
      contentType: 'application/pdf',
      bytes: 13,
      filename: 'Grundriß.pdf',
      base64: base64Of('%PDF-1.7 fake'),
    })
  })

  it('omits the file name when the route names none', async () => {
    const op = operation(async () => new Response(bytesOf('zip'), { headers: { 'content-type': 'application/octet-stream' } }))
    const result = await callOperation(op, {}, session)
    expect(isBinaryBody(result.body) && 'filename' in result.body).toBe(false)
  })

  it('is described, not sent, over the inline limit announced by Content-Length', async () => {
    const op = operation(
      async () =>
        new Response(new Uint8Array(10), {
          headers: { 'content-type': 'application/pdf', 'content-length': String(MAX_INLINE_BYTES + 1) },
        }),
    )
    const result = await callOperation(op, {}, session)
    expect(result.body).toEqual({ binary: true, contentType: 'application/pdf', bytes: MAX_INLINE_BYTES + 1, tooLarge: true })
  })

  it('stops reading a stream that grows past the limit without announcing its size', async () => {
    let pulled = 0
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1
        controller.enqueue(new Uint8Array(1024 * 1024))
        if (pulled > 50) controller.close()
      },
    })
    const op = operation(async () => new Response(stream, { headers: { 'content-type': 'application/pdf' } }))
    const result = await callOperation(op, {}, session)
    expect(result.body).toEqual({ binary: true, contentType: 'application/pdf', bytes: null, tooLarge: true })
    expect(pulled).toBeLessThan(15)
  })

  it('keeps an answer at exactly the limit inline', async () => {
    const op = operation(
      async () => new Response(new Uint8Array(MAX_INLINE_BYTES), { headers: { 'content-type': 'application/pdf' } }),
    )
    const result = await callOperation(op, {}, session)
    expect(isBinaryBody(result.body) && result.body.tooLarge).toBeFalsy()
    expect(isBinaryBody(result.body) && result.body.bytes).toBe(MAX_INLINE_BYTES)
  })

  it('still reads JSON and text as before', async () => {
    const json = operation(async () => Response.json({ a: 1 }))
    const text = operation(async () => new Response('hello', { headers: { 'content-type': 'text/markdown' } }))
    expect((await callOperation(json, {}, session)).body).toEqual({ a: 1 })
    expect((await callOperation(text, {}, session)).body).toBe('hello')
  })
})

describe('a JSON or text answer too large to read (M6)', () => {
  it('is described, not read, when Content-Length announces more than the cap', async () => {
    const op = operation(
      async () =>
        new Response('{}', {
          headers: { 'content-type': 'application/json', 'content-length': String(MAX_TEXT_BYTES + 1) },
        }),
    )
    const result = await callOperation(op, {}, session)
    expect(isOversizedBody(result.body)).toBe(true)
    expect(result.body).toMatchObject({ bytes: MAX_TEXT_BYTES + 1, contentType: 'application/json' })
  })

  it('stops reading a JSON stream that grows past the cap without announcing its size', async () => {
    let pulled = 0
    const chunk = new Uint8Array(1024 * 1024).fill(0x20)
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1
        // An answer with no end: only the cap stops it.
        controller.enqueue(chunk)
      },
    })
    const op = operation(async () => new Response(stream, { headers: { 'content-type': 'application/json' } }))
    const result = await callOperation(op, {}, session)
    expect(isOversizedBody(result.body)).toBe(true)
    expect(pulled).toBeLessThanOrEqual(MAX_TEXT_BYTES / chunk.byteLength + 2)
  })

  it('reads one at the cap, and an unparsable JSON body as null', async () => {
    const atCap = operation(async () => new Response(JSON.stringify('x'.repeat(MAX_TEXT_BYTES - 2)), { headers: { 'content-type': 'application/json' } }))
    expect(typeof (await callOperation(atCap, {}, session)).body).toBe('string')
    const broken = operation(async () => new Response('{nope', { headers: { 'content-type': 'application/json' } }))
    expect((await callOperation(broken, {}, session)).body).toBeNull()
  })
})

describe('If-Match', () => {
  it('reaches a route that reads the header as the header the browser sends', async () => {
    let seen: string | null = null
    const op = operation(
      async (request) => {
        seen = request.headers.get('if-match')
        return Response.json({ ok: true })
      },
      { method: 'PUT', ifMatchHeader: true },
    )
    await callOperation(op, { body: {}, ifMatch: '"7"' }, session)
    expect(seen).toBe('"7"')
  })

  it('is refused, never dropped, for a route that does not read the header', async () => {
    let called = false
    const op = operation(
      async () => {
        called = true
        return Response.json({ ok: true })
      },
      { method: 'POST' },
    )
    await expect(callOperation(op, { body: {}, ifMatch: '"7"' }, session)).rejects.toThrow(/takes no top-level ifMatch/)
    expect(called).toBe(false)
  })

  it('is offered only where the route reads it: the project profile PUT', async () => {
    const { AGENT_OPERATIONS } = await import('./catalog')
    expect(AGENT_OPERATIONS.filter((op) => op.ifMatchHeader).map((op) => op.name)).toEqual(['project-profile-replace'])
  })
})

describe('what reaches the route', () => {
  it('is the agent\'s input, not what the operation\'s schema made of it', async () => {
    // organization-download-log-list's query schema turns `from`/`to` into Dates. Forwarding that parsed copy
    // sent `2026-10-01T00:00:00.000Z` where the route parses YYYY-MM-DD, and every call with a day range was a 400.
    const real = findOperation('organization-download-log-list')!
    let query: string | null = null
    const op = { ...real, load: async () => ({ GET: async (request: Request) => ((query = new URL(request.url).search), Response.json({ rows: [] })) }) }
    const result = await callOperation(op, { query: { from: '2026-10-01', to: '2026-10-21' } }, session)
    expect(result.ok).toBe(true)
    expect(query).toBe('?from=2026-10-01&to=2026-10-21')
  })

  it('is still checked against the schema first', async () => {
    const real = findOperation('organization-download-log-list')!
    const op = { ...real, load: async () => ({ GET: async () => Response.json({}) }) }
    await expect(callOperation(op, { query: { from: 'yesterday' } }, session)).rejects.toThrow(/query\.from/)
  })
})

describe('a redirect', () => {
  it('is handed on as a location, not followed, and counts as success', async () => {
    const op = operation(
      async () => new Response(null, { status: 302, headers: { location: 'https://store.test/obj?X-Amz-Signature=abc' } }),
    )
    const result = await callOperation(op, {}, session)
    expect(result.status).toBe(302)
    expect(result.ok).toBe(true)
    expect(isRedirectBody(result.body) && result.body.location).toBe('https://store.test/obj?X-Amz-Signature=abc')
  })
})

describe('filenameFromDisposition', () => {
  it.each([
    [`attachment; filename="a b.pdf"`, 'a b.pdf'],
    [`attachment; filename=plain.docx`, 'plain.docx'],
    [`attachment; filename="x.pdf"; filename*=UTF-8''Gr%C3%BCn.pdf`, 'Grün.pdf'],
    ['inline', undefined],
    [null, undefined],
  ])('%s', (header, expected) => {
    expect(filenameFromDisposition(header)).toBe(expected)
  })
})

describe('a multipart upload', () => {
  const body = uploadBodySchemaWith({ projectId: z.string(), folderId: z.string().optional() })

  it('reaches the route as the form the UI sends: file part and text fields', async () => {
    let received: FormData | null = null
    let contentType: string | null = null
    const op = operation(
      async (request) => {
        contentType = request.headers.get('content-type')
        received = await request.formData()
        return Response.json({ ok: true })
      },
      { method: 'POST', body, bodyEncoding: 'multipart' },
    )
    await callOperation(
      op,
      {
        body: {
          files: [{ name: 'Plan.pdf', mimeType: 'application/pdf', contentBase64: base64Of('%PDF fake') }],
          fields: { projectId: 'p1', folderId: 'f1' },
        },
      },
      session,
    )
    expect(contentType).toMatch(/^multipart\/form-data; boundary=/)
    const form = received as unknown as FormData
    expect(form.get('projectId')).toBe('p1')
    expect(form.get('folderId')).toBe('f1')
    const file = form.get('file')
    expect(file).toBeInstanceOf(File)
    expect((file as File).name).toBe('Plan.pdf')
    expect((file as File).type).toBe('application/pdf')
    expect(await (file as File).text()).toBe('%PDF fake')
  })

  it('falls back to application/octet-stream and skips empty fields', () => {
    const form = formDataOf({ files: [{ name: 'a.bin', contentBase64: base64Of('x') }], fields: { folderId: '', projectId: 'p' } })
    expect((form.get('file') as File).type).toBe('application/octet-stream')
    expect([...form.keys()].sort()).toEqual(['file', 'projectId'])
  })

  it('refuses a file that is not base64 before the route runs', async () => {
    let ran = false
    const op = operation(async () => ((ran = true), Response.json({})), { method: 'POST', body: uploadBodySchema, bodyEncoding: 'multipart' })
    await expect(
      callOperation(op, { body: { files: [{ name: 'a', contentBase64: 'not base64!!' }] } }, session),
    ).rejects.toThrow(/contentBase64/)
    expect(ran).toBe(false)
  })

  it('refuses a second file and a file over the cap', () => {
    const one = { name: 'a', contentBase64: base64Of('x') }
    expect(uploadBodySchema.safeParse({ files: [one, one] }).success).toBe(false)
    const tooBig = 'A'.repeat(Math.ceil(MAX_UPLOAD_BYTES / 3) * 4 + 4)
    expect(uploadBodySchema.safeParse({ files: [{ name: 'a', contentBase64: tooBig }] }).success).toBe(false)
  })
})

describe('a raw upload', () => {
  it('sends the decoded bytes as application/octet-stream with their length', async () => {
    let seen: { type: string | null; length: string | null; text: string } | null = null
    const op = operation(
      async (request) => {
        seen = {
          type: request.headers.get('content-type'),
          length: request.headers.get('content-length'),
          text: await request.text(),
        }
        return Response.json({ partNumber: 2 })
      },
      { method: 'PUT', body: rawBodySchema, bodyEncoding: 'raw' },
    )
    const result = await callOperation(op, { body: { contentBase64: base64Of('part-two') } }, session)
    expect(result.body).toEqual({ partNumber: 2 })
    expect(seen).toEqual({ type: 'application/octet-stream', length: '8', text: 'part-two' })
  })
})
