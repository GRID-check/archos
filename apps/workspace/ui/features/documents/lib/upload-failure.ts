/**
 * The sentence an upload row (and the batch's line) says when a file did not
 * get onto the server, always in the reader's language.
 *
 * Every message that reaches a person comes from the dictionary. The
 * transport's (`XhrNetworkError`, `XhrUploadError`), the server envelope's
 * `error` and any other exception's `.message` are English and for logs: they
 * go to the console, never onto the row. A pilot office read the server's
 * „File exceeds the maximum upload size …" in its German setup because the
 * last branch here used to return `error.message`.
 *
 * Ingest failures, after the server accepted the file, are a different text
 * and say themselves through `ingest-failure.ts`.
 */

import { XhrNetworkError } from '@/lib/http/xhr-upload'
import { uploadRefusalOf, type UploadRefusal } from './upload-refusal'

/** The sentences an upload failure is said in, in the reader's language. */
export interface UploadFailureCopy {
  projectClosed: string
  failed: string
  network: string
  stalled: string
  timeout: string
  folderReadOnly: string
  changedMeanwhile: string
  screeningUnavailable: string
  storageFull: string
  nameTaken: (name: string) => string
  heldReplace: (name: string) => string
  /** `limitBytes` null when the server did not say the limit. */
  tooLarge: (name: string, limitBytes: number | null) => string
  invalidType: (name: string, accepted: string[]) => string
}

/**
 * An error whose message is already a sentence for the reader, from the
 * dictionary: what a failed file throws on to the batch, so the batch's line
 * repeats the row's sentence instead of falling back to the generic one.
 */
export class UploadFailureSentence extends Error {
  constructor(sentence: string, options?: { cause?: unknown }) {
    super(sentence, options)
    this.name = 'UploadFailureSentence'
  }
}

/** A refusal the server gave a reason for, said from the dictionary (`./upload-refusal`). */
export function refusalSentence(refusal: UploadRefusal, copy: UploadFailureCopy, fileName: string): string {
  switch (refusal.kind) {
    case 'held-replace':
      return copy.heldReplace(fileName)
    case 'name-taken':
      return copy.nameTaken(fileName)
    case 'project-closed':
      return copy.projectClosed
    case 'folder-read-only':
      return copy.folderReadOnly
    case 'changed-meanwhile':
      return copy.changedMeanwhile
    case 'screening-unavailable':
      return copy.screeningUnavailable
    case 'too-large':
      return copy.tooLarge(fileName, refusal.limitBytes)
    case 'storage-full':
      return copy.storageFull
    case 'invalid-type':
      return copy.invalidType(fileName, refusal.accepted)
    case 'name-stop':
    case 'other':
      return copy.failed
  }
}

/** The clearest sentence available about why an upload did not happen. Never the error's own text. */
export function uploadFailureSentence(error: unknown, copy: UploadFailureCopy, fileName = ''): string {
  if (error instanceof UploadFailureSentence) return error.message
  if (error instanceof XhrNetworkError) return copy[error.reason]
  const refusal = uploadRefusalOf(error)
  if (refusal) return refusalSentence(refusal, copy, fileName)
  return copy.failed
}
