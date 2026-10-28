import { type FC, type ReactNode, useEffect, useState } from 'react'
import { Check, FileText, RotateCw, ShieldAlert, X, XCircle } from 'lucide-react'
import { Spinner } from '@/components/ui/spinner'
import { cn } from '@/lib/utils'
import { motion, useIconSwapTransition } from '@/components/motion'
import type { TrackedFile } from '@/features/documents/types'
import { failedWhileReading } from '@/features/documents/lib/ingest-failure'
import { useIngestFailureText } from '@/features/documents/components/ingest-failure-notice'
import { heldSentenceKey, quarantineVerdictOf } from '@/lib/upload-screening/quarantine'
import { useTranslations } from '@/i18n'
import { filesCopy } from '@/i18n/namespaces/files'
import { researchCopy } from '@/i18n/namespaces/research'

/**
 * The photo itself, small, on its chip: a site photo is recognised by what it
 * shows, never by `Foto 2026-10-15 14-32-05.jpg`. Only for a file this tab
 * picked (a listed file has no bytes here), and only for an image type.
 */
function usePhotoThumbnail(file: File | undefined): ReactNode {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    if (!file || !file.type.startsWith('image/') || typeof URL.createObjectURL !== 'function') {
      setUrl(null)
      return
    }
    const next = URL.createObjectURL(file)
    setUrl(next)
    return () => URL.revokeObjectURL(next)
  }, [file])
  if (!url) return null
  return (
    // oxlint-disable-next-line nextjs/no-img-element -- a blob: URL of a file in this tab; the optimizer cannot fetch it
    <img
      src={url}
      alt=""
      aria-hidden="true"
      data-testid="file-chip-thumbnail"
      className="size-5 shrink-0 rounded-[4px] object-cover pointer-coarse:size-8"
    />
  )
}

/**
 * Inline removable file chip shown above the composer textarea. Live status:
 * spinner while uploading/ingesting, green check on success, red on failure
 * (failed chips also offer a retry), a warning shield on a file the content
 * check held back (its title says why; never a retry), a muted file glyph on
 * one stored and not read. The ✕ deletes the file.
 *
 * A successful chip's icon+name form a button that opens the shared read-only
 * FilePreviewDialog — the primary way back to an attached file, and on mobile
 * (where the manage-files button is hidden) the main file-access path. Chips
 * that are still uploading/ingesting or have failed are not openable (there is
 * nothing to preview yet); their body stays inert and only retry/remove act.
 */
export const FileChip: FC<{
  file: TrackedFile
  onOpen: (file: TrackedFile) => void
  onRemove: (id: string) => void
  onRetry: (id: string) => void
  /**
   * A reader who may not change this conversation (a viewer in a shared thread).
   * Opening a file stays available — that is reading — but retry and remove are
   * writes onto somebody else's thread and are not rendered at all. Disabled
   * buttons would be the wrong shape here: there is no state in which this
   * person could press them, so offering them greyed out is a promise.
   */
  readOnly?: boolean
}> = ({ file, onOpen, onRemove, onRetry, readOnly = false }) => {
  const t = useTranslations(researchCopy)
  const isPending = file.status === 'uploading' || file.status === 'ingesting'
  const isFailed = file.status === 'failed'
  // Held back by the content check (ADR-0086): a reason, not a failure, and
  // never retried — the server refuses a re-upload onto a held file.
  const isHeld = file.status === 'held'
  // Kept and never read: the chat cannot answer from it, so no green check.
  const isStored = file.status === 'stored'
  const isSuccess = file.status === 'success'
  // Whether the reader watched this chip work: only then does its check land
  // (on the icon-swap spring) when the file turns readable. A chip that was
  // already ready when the thread opened shows its check standing.
  const [sawPending, setSawPending] = useState(isPending)
  if (isPending && !sawPending) setSawPending(true)
  const glyph = useIconSwapTransition()
  const thumbnail = usePhotoThumbnail(file.file)
  // A file refused because the document it replaces is held carries a
  // sentence, not a verdict (ADR-0086): it is said as it is.
  // A file the content check held says why from its verdict, with the same
  // sentence the findings use (`heldSentenceKey`), never from its message.
  const tFiles = useTranslations(filesCopy)
  const heldSentence = isHeld
    ? file.replacesHeld
      ? file.errorMessage
      : tFiles(heldSentenceKey(quarantineVerdictOf(file)))
    : null
  const ingestFailure = useIngestFailureText(
    isFailed && failedWhileReading(file) ? file.errorMessage : null
  )
  // Uploading and reading are both pending, but only one of them is an upload.
  const statusTitle = isPending
    ? t(
        file.status === 'ingesting'
          ? 'fileSourceCard.statusIngesting'
          : 'inputArea.fileUploadingStatus'
      )
    : isHeld
      ? heldSentence || t('fileSourceCard.statusHeld')
      : isStored
        ? t('fileSourceCard.statusStored')
        : isFailed
          ? (ingestFailure?.sentence ?? (file.errorMessage || t('inputArea.fileFailedStatus')))
          : t('inputArea.fileReadyStatus')

  const statusIcon = isPending ? (
    <Spinner size="xs" className="text-muted-foreground" />
  ) : isHeld ? (
    // A shape of its own, in the warning colour: nothing failed.
    <>
      <ShieldAlert className="text-warning size-3 shrink-0" aria-hidden="true" />
      <span className="sr-only">{t('fileSourceCard.statusHeld')}</span>
    </>
  ) : isStored ? (
    <>
      <FileText className="text-muted-foreground size-3 shrink-0" aria-hidden="true" />
      <span className="sr-only">{t('fileSourceCard.statusStored')}</span>
    </>
  ) : isFailed ? (
    // A distinct glyph (not a bare red dot) so the failure carries a shape, not
    // color alone — plus an sr-only label so it isn't inferred only from color.
    <>
      <XCircle className="text-destructive size-3 shrink-0" aria-hidden="true" />
      <span className="sr-only">{t('inputArea.fileFailedStatus')}</span>
    </>
  ) : (
    <motion.span
      className="inline-flex shrink-0"
      initial={sawPending ? { opacity: 0, scale: 0.6 } : false}
      animate={{ opacity: 1, scale: 1, transition: glyph.enter }}
    >
      <Check className="text-status-active size-3 shrink-0" aria-hidden="true" />
    </motion.span>
  )

  return (
    <span
      className={cn(
        'bg-card inline-flex h-7 max-w-[200px] shrink-0 items-center gap-1.5 rounded-md border px-2 text-xs',
        // A finger has to be able to hit the remove-x, and that button can only
        // grow inside a taller chip — the strip scrolls horizontally, so the
        // extra height costs nothing but a slightly shorter filename.
        // `max-w` grows with it: the buttons inside are 44px square now, so at
        // 200px a failed chip (retry AND remove) had ~90px left for a filename.
        // The strip already scrolls sideways, so width here is free.
        'pointer-coarse:h-11 pointer-coarse:max-w-[260px]',
        // `border-error` is a static `@utility` in globals.css with no
        // `--modifier()`, so the slash form (`border-error/50`) matched nothing
        // and this chip kept the neutral default border — a failed upload was
        // signalled by the glyph alone. The token itself already carries ~55%
        // alpha, so the solid class is the soft edge the author was after.
        isFailed && 'border-error'
      )}
      title={`${file.fileName} — ${statusTitle}`}
    >
      {isSuccess ? (
        <button
          type="button"
          onClick={() => onOpen(file)}
          aria-label={t('inputArea.openFile', { name: file.fileName })}
          className="text-foreground/85 focus-visible:ring-ring/50 flex min-w-0 flex-1 items-center gap-1.5 rounded-sm focus-visible:ring-2 focus-visible:outline-none pointer-coarse:min-h-11"
        >
          {statusIcon}
          {thumbnail}
          <span className="min-w-0 truncate">{file.fileName}</span>
        </button>
      ) : (
        <span className="flex min-w-0 flex-1 items-center gap-1.5">
          {statusIcon}
          {thumbnail}
          <span className="text-foreground/85 min-w-0 truncate">{file.fileName}</span>
        </span>
      )}
      {isFailed && !readOnly && (
        <button
          type="button"
          onClick={() => onRetry(file.id)}
          aria-label={t('inputArea.retryUpload')}
          title={t('inputArea.retryUpload')}
          // The chip above is already `pointer-coarse:h-11` precisely so this
          // button could grow inside it — and then the button stopped at 36.
          // `size-11` fills the height the chip is already paying for.
          className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 inline-flex shrink-0 items-center justify-center rounded-sm focus-visible:ring-2 focus-visible:outline-none pointer-coarse:size-11"
        >
          <RotateCw className="size-3" aria-hidden="true" />
        </button>
      )}
      {!readOnly && (
        <button
          type="button"
          onClick={() => onRemove(file.id)}
          aria-label={t('inputArea.removeFile', { name: file.fileName })}
          title={t('inputArea.removeFile', { name: file.fileName })}
          // The chip above is already `pointer-coarse:h-11` precisely so this
          // button could grow inside it — and then the button stopped at 36.
          // `size-11` fills the height the chip is already paying for.
          className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 inline-flex shrink-0 items-center justify-center rounded-sm focus-visible:ring-2 focus-visible:outline-none pointer-coarse:size-11"
        >
          <X className="size-3" aria-hidden="true" />
        </button>
      )}
    </span>
  )
}
