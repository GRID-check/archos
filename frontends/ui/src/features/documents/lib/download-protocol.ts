'use client'

/**
 * Download a Protokoll: a document's (`ReviewExportMenu`) or a project's
 * Offene Punkte (`ProjectProtocolMenu`), one path for both.
 *
 * Fetched rather than navigated to, as the answer export is: a refusal (a PDF
 * too long to lay out, too many marks for one Protokoll, access lost meanwhile)
 * comes back as what it was, for the menu to say in a toast, not as a JSON
 * file in the downloads folder.
 */

import { startBrowserDownload } from '@/lib/browser-download'
import { fileNameFromDisposition } from '@/lib/annotations/export-request'

/** How a download went: saved, or refused with the status and the body's `details.reason` (null when it never got an answer). */
export type ProtocolDownload = { saved: true } | { saved: false; status: number | null; reason: string | null }

/** Fetch the file at `href` and hand it to the browser's download, named as the server named it. */
export async function downloadProtocol(href: string, fallbackName: string): Promise<ProtocolDownload> {
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
