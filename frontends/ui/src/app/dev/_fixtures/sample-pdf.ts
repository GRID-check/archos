/**
 * A real PDF, built byte by byte, for the `/dev` previews that render one.
 *
 * pdf.js parses what it is given, so a preview of the viewer needs genuine
 * bytes, not an image standing in for them. One builder for every preview
 * (`/dev/pdf-passage`, `/dev/file-preview`): two private copies of a
 * cross-reference table would drift, and the one with the wrong offsets would
 * still look fine until pdf.js reported the file as damaged.
 */

/** One printed line: text, point size, bold. */
export type PdfLine = readonly [string, number, boolean]

/** A4 portrait, in points. */
const PAGE_WIDTH = 595
const PAGE_HEIGHT = 842

/** Escape the three characters a PDF literal string cannot carry raw. */
export const pdfString = (text: string): string => text.replace(/([\\()])/g, '\\$1')

/** One page's content stream, laid out from the top margin down. */
const contentStream = (lines: readonly PdfLine[]): string => {
  let content = ''
  let y = PAGE_HEIGHT - 70
  for (const [text, size, bold] of lines) {
    if (text) {
      content += `BT /${bold ? 'F2' : 'F1'} ${size} Tf 1 0 0 1 64 ${y} Tm (${pdfString(text)}) Tj ET\n`
    }
    y -= size + 8
  }
  return content
}

/**
 * Assemble the document, one page per entry of `pages`.
 *
 * Written out longhand rather than pulled from a library because the whole file
 * is a hundred lines of it, and because the cross-reference table has to carry
 * real byte offsets — which is exactly what a string-concatenating "generator"
 * gets wrong. Every character stays below U+0100, so the string's indices ARE
 * its byte offsets and WinAnsi encodes umlauts one byte each.
 *
 * Object numbering, since the Kids array has to name it before the objects
 * exist: 1 catalog, 2 pages, then one page object per sheet, then one content
 * stream per sheet, then the two fonts.
 */
export const buildPdf = (pages: readonly (readonly PdfLine[])[]): Uint8Array<ArrayBuffer> => {
  const count = pages.length
  const firstPage = 3
  const firstContent = firstPage + count
  const [regular, bold] = [firstContent + count, firstContent + count + 1]
  const kids = pages.map((_, index) => `${firstPage + index} 0 R`).join(' ')

  const objects = [
    '<</Type/Catalog/Pages 2 0 R>>',
    `<</Type/Pages/Kids[${kids}]/Count ${count}>>`,
    ...pages.map(
      (_, index) =>
        `<</Type/Page/Parent 2 0 R/MediaBox[0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}]` +
        `/Resources<</Font<</F1 ${regular} 0 R/F2 ${bold} 0 R>>>>` +
        `/Contents ${firstContent + index} 0 R>>`
    ),
    ...pages.map((lines) => {
      const content = contentStream(lines)
      return `<</Length ${content.length}>>\nstream\n${content}endstream`
    }),
    '<</Type/Font/Subtype/Type1/BaseFont/Helvetica/Encoding/WinAnsiEncoding>>',
    '<</Type/Font/Subtype/Type1/BaseFont/Helvetica-Bold/Encoding/WinAnsiEncoding>>',
  ]

  return assemblePdf(objects)
}

/**
 * Number the objects, write them, and close the file with a cross-reference
 * table of their real byte offsets. Every character stays below U+0100, so the
 * string's indices are its byte offsets.
 */
export const assemblePdf = (objects: readonly string[]): Uint8Array<ArrayBuffer> => {
  let file = '%PDF-1.4\n'
  const offsets: number[] = []
  objects.forEach((body, index) => {
    offsets.push(file.length)
    file += `${index + 1} 0 obj\n${body}\nendobj\n`
  })

  const xrefStart = file.length
  file += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets) file += `${String(offset).padStart(10, '0')} 00000 n \n`
  file += `trailer\n<</Size ${objects.length + 1}/Root 1 0 R>>\nstartxref\n${xrefStart}\n%%EOF\n`

  const bytes = new Uint8Array(new ArrayBuffer(file.length))
  for (let i = 0; i < file.length; i += 1) bytes[i] = file.charCodeAt(i) & 0xff
  return bytes
}

/**
 * A one-page PDF encrypted with the user password `piloti` (RC4, 128 bit), for
 * the viewer's password prompt. Not built here: the encryption dictionary and
 * the encrypted streams are cryptography, not layout, and a hand-rolled RC4 in
 * a fixture would be a second implementation to get wrong. Made with pypdf:
 * `PdfWriter().add_blank_page(595, 842)` then
 * `encrypt(user_password="piloti", owner_password="piloti", algorithm="RC4-128")`.
 */
export const ENCRYPTED_PDF_PASSWORD = 'piloti'

export const encryptedPdf = (): Uint8Array<ArrayBuffer> =>
  Uint8Array.from(atob(
    'JVBERi0xLjMKJeLjz9MKMSAwIG9iago8PAovUHJvZHVjZXIgPDAzMjcyODBiNDQ+Cj4+CmVuZG9iagoyIDAgb2JqCjw8Ci9UeXBlIC9QYWdlcwovQ291bnQgMQovS2lkcyBbIDQgMCBSIF0KPj4KZW5kb2JqCjMgMCBvYmoKPDwKL1R5cGUgL0NhdGFsb2cKL1BhZ2VzIDIgMCBSCj4+CmVuZG9iago0IDAgb2JqCjw8Ci9UeXBlIC9QYWdlCi9SZXNvdXJjZXMgPDwKPj4KL01lZGlhQm94IFsgMC4wIDAuMCA1OTUgODQyIF0KL1BhcmVudCAyIDAgUgo+PgplbmRvYmoKNSAwIG9iago8PAovViAyCi9SIDMKL0xlbmd0aCAxMjgKL1AgNDI5NDk2NzI5MgovRmlsdGVyIC9TdGFuZGFyZAovTyA8YjhmMTM4OWE0ODU1YTkxOGQ5Nzk2ZjhkMTcxNTkwMGQxZjZkZWVhYmQzMDhkYzRlMGQ5OGE4YzQyY2FmMjc5NT4KL1UgPDA3YTAzMDI3ODczZmU0Y2IzMjQyOGNhZWQ0MWFlYTc5MjhiZjRlNWU0ZTc1OGE0MTY0MDA0ZTU2ZmZmYTAxMDg+Cj4+CmVuZG9iagp4cmVmCjAgNgowMDAwMDAwMDAwIDY1NTM1IGYgCjAwMDAwMDAwMTUgMDAwMDAgbiAKMDAwMDAwMDA1OSAwMDAwMCBuIAowMDAwMDAwMTE4IDAwMDAwIG4gCjAwMDAwMDAxNjcgMDAwMDAgbiAKMDAwMDAwMDI2MSAwMDAwMCBuIAp0cmFpbGVyCjw8Ci9TaXplIDYKL1Jvb3QgMyAwIFIKL0luZm8gMSAwIFIKL0lEIFsgPDM0MzEzNzMzMzAzMDY1MzM2MTMyMzM2MjY2NjYzMzM5NjI2NjY0MzQ2NDM3NjEzOTM0MzEzNDM4MzkzMTYzMzQ+IDwzNDMxMzczMzMwMzA2NTMzNjEzMjMzNjI2NjY2MzMzOTYyNjY2NDM0NjQzNzYxMzkzNDMxMzQzODM5MzE2MzM0PiBdCi9FbmNyeXB0IDUgMCBSCj4+CnN0YXJ0eHJlZgo0NzYKJSVFT0YK',
  ), (character) => character.charCodeAt(0))
