/**
 * One request to confirm, or take back, that a newer document replaces an older
 * one (CONTEXT.md, „Fassung"), and what the server says is true afterwards.
 *
 * `PUT /api/documents/{newer}/revision`. The answer carries the facts of BOTH
 * documents as this reader now sees them, because the link changes both cards:
 * the newer one's „ersetzt …" and the older one's „ersetzt durch …". Modelled
 * on `reingest-request.ts`, but a refusal throws: the caller owns the toast.
 */

import { EMPTY_REVISION_LINKS, type RevisionLinks } from '@/lib/documents/revision-links'

export interface RevisionLinkAnswer {
  /** The newer document's facts. */
  newer: RevisionLinks
  /** The older document's facts. */
  older: RevisionLinks
}

/** A refusal or a failed request. `status` is the HTTP status, `0` when nothing answered. */
export class RevisionRequestError extends Error {
  constructor(readonly status: number) {
    super(`Fassung request failed (${status})`)
    this.name = 'RevisionRequestError'
  }
}

interface WireAnswer {
  revision?: RevisionLinks | null
  older?: { revision?: RevisionLinks | null } | null
}

/** Link (`linked: true`) or unlink the two documents. Answers both documents' facts; throws {@link RevisionRequestError}. */
export async function requestRevisionLink(newerId: string, olderId: string, linked: boolean): Promise<RevisionLinkAnswer> {
  let res: Response
  try {
    res = await fetch(`/api/documents/${encodeURIComponent(newerId)}/revision`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ older: olderId, linked }),
    })
  } catch {
    throw new RevisionRequestError(0)
  }
  if (!res.ok) throw new RevisionRequestError(res.status)
  const body = ((await res.json().catch(() => ({}))) ?? {}) as WireAnswer
  return { newer: body.revision ?? EMPTY_REVISION_LINKS, older: body.older?.revision ?? EMPTY_REVISION_LINKS }
}

/** The newer document's facts after linking or unlinking (`EMPTY_REVISION_LINKS` when none); throws {@link RevisionRequestError}. */
export async function setRevisionLink(newerId: string, olderId: string, linked: boolean): Promise<RevisionLinks> {
  return (await requestRevisionLink(newerId, olderId, linked)).newer
}
