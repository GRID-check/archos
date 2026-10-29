/**
 * Read a request body as text, refusing it once it passes `maxBytes`.
 *
 * Next bounds only server actions' bodies (`bodySizeLimit`); a route handler
 * reads whatever arrives. A declared `content-length` past the cap is refused
 * before a byte is read, and a body without one (chunked) is refused as soon as
 * it crosses the cap, so the cap holds either way.
 */

import { PayloadTooLargeError } from './errors'

export async function readBoundedText(request: Request, maxBytes: number): Promise<string> {
  const declared = Number(request.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) throw new PayloadTooLargeError(maxBytes)
  if (!request.body) return ''
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
  return new TextDecoder().decode(bytes)
}
