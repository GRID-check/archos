/**
 * A header-safe `Content-Disposition` for a stored file's name.
 *
 * One home for the three streams that hand a stored object to a person (the
 * presigned download and preview, the PDF stream, a version's bytes), so a
 * file name with a quote or a line break is neutralised the same way in all of
 * them.
 */

/**
 * Filenames are user-controlled and end up in the `Content-Disposition` of
 * presigned URLs — strip header-breaking characters (CR/LF, double quotes),
 * cap the length, and never emit an empty name.
 */
function sanitizeFilename(raw: string): string {
  const cleaned = raw
    .replace(/[\r\n"]/g, '')
    .trim()
    .slice(0, 255)
  return cleaned || 'download'
}

/** RFC 5987 percent-encoding for the `filename*` parameter. */
function encodeRfc5987(value: string): string {
  return encodeURIComponent(value).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
  )
}

/**
 * Build a header-safe Content-Disposition: an ASCII-only `filename` fallback
 * plus the RFC 5987 `filename*` carrying the full UTF-8 name.
 */
export function contentDisposition(type: 'attachment' | 'inline', rawFilename: string): string {
  const filename = sanitizeFilename(rawFilename)
  const asciiFallback = filename.replace(/[^\x20-\x7e]/g, '_').replace(/[\\]/g, '_') || 'download'
  return `${type}; filename="${asciiFallback}"; filename*=UTF-8''${encodeRfc5987(filename)}`
}
