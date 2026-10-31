/**
 * Read a request body, refusing it once it passes `maxBytes`.
 *
 * Next bounds only server actions' bodies (`bodySizeLimit`); a route handler
 * reads whatever arrives. A declared `content-length` past the cap is refused
 * before a byte is read, and a body without one (chunked, or a `FormData` the
 * agent door builds in process) is refused as soon as it crosses the cap, so
 * the cap holds either way.
 */

import { BadRequestError, PayloadTooLargeError } from './errors'

export async function readBoundedBytes(request: Request, maxBytes: number): Promise<Uint8Array<ArrayBuffer>> {
  const declared = Number(request.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) throw new PayloadTooLargeError(maxBytes)
  if (!request.body) return new Uint8Array(0)
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined)
      throw new PayloadTooLargeError(maxBytes)
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

export async function readBoundedText(request: Request, maxBytes: number): Promise<string> {
  return new TextDecoder().decode(await readBoundedBytes(request, maxBytes))
}

/** A multipart body read within `maxBytes`, then parsed; a body that is no multipart form is a 400. */
export async function readBoundedFormData(request: Request, maxBytes: number): Promise<FormData> {
  const bytes = await readBoundedBytes(request, maxBytes)
  const contentType = request.headers.get('content-type') ?? ''
  try {
    return await new Response(bytes, { headers: { 'content-type': contentType } }).formData()
  } catch {
    throw new BadRequestError('Request body is not multipart form data')
  }
}
