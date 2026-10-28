/**
 * Upload admission: the gates a file passes before a byte of it is stored
 * (ADR-0086), in one order, for both upload doors.
 *
 * There are two doors: `uploadToShelf` (`./shelf-upload`, the project and the
 * Archiv, and with it revision upload, photo capture and mail import) and
 * `uploadSessionDocument` (`@/lib/session-documents/service`, a chat
 * attachment). Each used to restate the gates, and the two had drifted into
 * different orders. The order is:
 *
 *   1. name screen (Namensprüfung): the office's policy, read fresh; a held-back
 *      name is `422 UPLOAD_SCREENED` unless released, an unreadable policy
 *      `503 UPLOAD_SCREENING_UNAVAILABLE`. First, as in the browser, where the
 *      name gate runs before anything else leaves it;
 *   2. type: the accepted-types allow-list (`400`);
 *   3. size: the per-file limit (`413`);
 *   4. quota: the organization's storage ceiling (`507`), after the per-file
 *      limit so the more specific complaint comes first (ADR-0042).
 *
 * Each gate keeps its own error type; this module only fixes the order. What a
 * door checks before admission (that the caller may write there, that the
 * folder exists for them) stays in the door, because the name screen reads the
 * folder path and must not read one the caller may not see.
 */

import 'server-only'
import type { AuthorizedSession } from '@/lib/auth/types'
import { assertFileSizeAllowed } from '@/lib/storage/upload-limit'
import { assertWithinStorageQuota } from '@/lib/storage/service'
import { assertUploadNameAllowed, type NameGateResult } from '@/lib/upload-screening/service'
import { assertUploadTypeAllowed } from './upload-type'

interface UploadAdmissionInput {
  /** The file's name as the uploader sent it. */
  filename: string
  /** Its size in bytes. */
  size: number
  /** The relative path it was dropped from, normalized (`normalizeOriginPath`). */
  originPath: string | null
  /** The folder it is filed into, as the name screen reads it; absent on a chat. */
  folderPath?: string | null
  /** The project it goes into: the project's own name terms apply (migration 0154). */
  projectId?: string | null
  /** The uploader's explicit per-file "upload anyway" for the name screen. */
  screeningRelease: boolean
}

/**
 * Run every gate, in order, and hand back what the name screen let through so
 * the door can audit an override once the document has an id.
 */
export async function admitUpload(session: AuthorizedSession, input: UploadAdmissionInput): Promise<NameGateResult> {
  const nameGate = await assertUploadNameAllowed(
    session.organizationId,
    { filename: input.filename, originPath: input.originPath, folderPath: input.folderPath },
    input.screeningRelease,
    input.projectId,
  )
  await admitFileBeforeReading(session, input)
  await assertWithinStorageQuota(session.organizationId, input.size)
  return nameGate
}

/**
 * The gates that need neither the bytes nor the destination: type, then size.
 *
 * Mail import asks these before it fetches an attachment from the archive, so
 * a file the upload would refuse is never read; the full admission still runs
 * when the attachment is filed.
 */
export async function admitFileBeforeReading(
  session: AuthorizedSession,
  file: { filename: string; size: number },
): Promise<void> {
  await assertUploadTypeAllowed(session, file.filename)
  await assertFileSizeAllowed(session.organizationId, file.size, file.filename)
}
