import { describe, expect, it } from 'vitest'
import { translatorFor } from '@/i18n/namespace'
import { filesCopy } from '@/i18n/namespaces/files'
import { XhrNetworkError, XhrUploadError } from '@/lib/http/xhr-upload'
import { UploadFailureSentence, uploadFailureSentence, type UploadFailureCopy } from './upload-failure'

const t = translatorFor(filesCopy, 'de')

/** The copy the hook builds, in German, as the pilot office read it. */
const copy: UploadFailureCopy = {
  projectClosed: t('errors.projectClosed'),
  failed: t('errors.uploadFailed'),
  network: t('errors.uploadNetwork'),
  stalled: t('errors.uploadStalled'),
  timeout: t('errors.uploadTimeout'),
  folderReadOnly: t('folders.access.readOnlyRefused'),
  changedMeanwhile: t('errors.uploadChangedMeanwhile'),
  screeningUnavailable: t('errors.screeningPolicyUnavailable'),
  storageFull: t('errors.uploadStorageFull'),
  nameTaken: (name) => t('errors.nameTaken', { name }),
  heldReplace: (name) => t('errors.quarantinedReplace', { name }),
  tooLarge: (name, limit) =>
    limit === null ? t('errors.uploadTooLarge', { name }) : t('errors.uploadTooLargeLimit', { name, limit: '100 MB' }),
  invalidType: (name, accepted) => t('errors.validation.invalidType', { name, accepted: accepted.join(', ') }),
}

const answer = (status: number, body: unknown): XhrUploadError =>
  new XhrUploadError(`Upload failed: ${status}`, status, JSON.stringify(body))

/** English the server, the transport or the runtime writes, which must never reach the row. */
const ENGLISH = /\b(file|exceeds|maximum|upload|failed|storage|quota|permitted|unexpected|token|internal)\b/i

describe('uploadFailureSentence', () => {
  it.each([
    ['a size refusal', answer(413, { error: 'File exceeds the maximum upload size of 100 MB', code: 'FILE_TOO_LARGE', details: { maxSizeBytes: 1e8 } })],
    ['a body cut off in transit', answer(413, { error: 'Request body exceeds the maximum accepted size', code: 'PAYLOAD_TOO_LARGE' })],
    ['a full store', answer(507, { error: 'Storage quota exceeded', code: 'STORAGE_QUOTA_EXCEEDED' })],
    ['a type refusal', answer(400, { error: 'File type "exe" is not permitted', details: { extension: 'exe', accepted: ['pdf'] } })],
    ['a refusal with no reason', answer(500, { error: 'Internal server error' })],
    ['a gateway page', new XhrUploadError('Upload failed: 502', 502, '<html>Bad Gateway</html>')],
    ['a parse error', new SyntaxError('Unexpected token < in JSON at position 0')],
    ['any other exception', new Error('Failed to create collection: internal')],
    ['a network failure', new XhrNetworkError('network')],
  ])('says %s in German, never in the error’s own words', (_, error) => {
    const sentence = uploadFailureSentence(error, copy, 'Einreichplan.pdf')
    expect(sentence).not.toMatch(ENGLISH)
    expect(sentence).not.toContain((error as Error).message)
  })

  it('names the file and the limit a size refusal states', () => {
    const error = answer(413, { code: 'FILE_TOO_LARGE', details: { maxSizeBytes: 1e8 } })
    expect(uploadFailureSentence(error, copy, 'Einreichplan.pdf')).toBe(
      '„Einreichplan.pdf“ ist größer, als Ihr Büro hochladen darf: höchstens 100 MB pro Datei.'
    )
  })

  it('passes a sentence a row already said on to the batch’s line', () => {
    const said = new UploadFailureSentence(copy.storageFull, { cause: answer(507, {}) })
    expect(uploadFailureSentence(said, copy)).toBe(copy.storageFull)
  })
})
