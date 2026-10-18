/**
 * Start a file download without navigating the SPA away.
 *
 * `window.location.assign` on a presigned object-store URL leaves the app
 * whenever the store ignores `ResponseContentDisposition` — SeaweedFS often
 * does, so the "download" button used to replace the whole tab with the file.
 * An `<a download>` keeps the page. The attribute is only a hint on
 * cross-origin URLs, so the click also opens a new browsing context: if the
 * store honours attachment the file saves; if it does not, the file still
 * arrives in a tab instead of evicting the app.
 */
export function startBrowserDownload(url: string, filename?: string): void {
  if (typeof document === 'undefined' || url === '') return
  const anchor = document.createElement('a')
  anchor.href = url
  if (filename) anchor.download = filename
  anchor.rel = 'noopener'
  anchor.target = '_blank'
  anchor.referrerPolicy = 'no-referrer'
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
}

/**
 * The file name a `Content-Disposition` carries: the UTF-8 `filename*` first
 * (it keeps „Fassung" and the dashes), then the ASCII fallback, then `fallback`.
 */
export function fileNameFromDisposition(header: string | null, fallback: string): string {
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(header ?? '')?.[1]
  if (encoded) {
    try {
      return decodeURIComponent(encoded)
    } catch {
      // A malformed escape: the plain name below still names the file.
    }
  }
  return /filename="([^"]+)"/i.exec(header ?? '')?.[1] ?? fallback
}

/** How a fetched download went: saved, or refused with the status and the body's `details.reason` (null when it never got an answer). */
export type FetchedDownload = { saved: true } | { saved: false; status: number | null; reason: string | null }

/**
 * Fetch the file a route builds and hand it to the browser's download, named
 * as the server named it ({@link fileNameFromDisposition}, else `fallbackName`).
 *
 * Fetched rather than navigated to: a refusal (a PDF too long to lay out,
 * access lost meanwhile) comes back as what it was, for the caller to say in a
 * toast, not as a JSON file in the downloads folder or an error filling a tab.
 */
export async function downloadFetched(href: string, fallbackName: string): Promise<FetchedDownload> {
  try {
    const response = await fetch(href)
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { details?: { reason?: unknown } } | null
      const reason = body?.details?.reason
      return { saved: false, status: response.status, reason: typeof reason === 'string' ? reason : null }
    }
    const url = URL.createObjectURL(await response.blob())
    try {
      startBrowserDownload(url, fileNameFromDisposition(response.headers.get('content-disposition'), fallbackName))
    } finally {
      // The download holds the blob by reference; the URL can go on the next tick.
      window.setTimeout(() => URL.revokeObjectURL(url), 1000)
    }
    return { saved: true }
  } catch {
    return { saved: false, status: null, reason: null }
  }
}
