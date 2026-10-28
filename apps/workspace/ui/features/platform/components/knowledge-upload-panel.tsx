'use client'

/**
 * Adding documents to the base corpus: the dropzone, and what happens after a
 * drop until every file has been indexed, timed out or gone missing.
 *
 * The dropzone is a real `<button>`, so Tab, Enter and Space reach the file
 * picker without a hand-rolled key handler. While an upload or a sync is
 * running it is `aria-disabled` rather than `disabled`: a disabled button
 * swallows the drop, and a drop that silently does nothing is the bug this
 * replaced. Instead a drag while busy says why it will be refused.
 *
 * The drop is `useFileDragDrop`'s, like every other zone: a folder is read
 * through, every PDF and ZIP in the drop is added (it took the first file and
 * dropped the rest without a word), the highlight no longer flickers as the
 * pointer crosses the zone's own text, and it ends however the drag ends. A
 * file released beside the zone is stopped by the window guard instead of
 * replacing the admin page with the PDF.
 */

import type { JSX } from 'react'
import { useRef } from 'react'
import { toast } from 'sonner'
import { AlertCircle, RefreshCw, Upload } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Spinner } from '@/components/ui/spinner'
import { useWindowDragGuard } from '@/features/documents/components/file-drop-overlay'
import { useFileDragDrop } from '@/features/documents/hooks/use-file-drag-drop'
import { KnowledgeStateBadge } from '@/features/platform/components/knowledge-atoms'
import type { WatchItem } from '@/features/platform/components/knowledge-ingest-watch'
import { useTranslations } from '@/i18n'
import { platformCopy } from '@/i18n/namespaces/platform'
import type { KnowledgeUploadResult } from '@/lib/knowledge/service'
import { cn } from '@/lib/utils'

export interface KnowledgeUploadPanelProps {
  /** Show the dropzone. The file input stays mounted either way. */
  open: boolean
  isUploading: boolean
  /** An upload or a sync is running; a new file has to wait. */
  isBusy: boolean
  /** The PDFs and ZIPs to add, in the order they were chosen or dropped. */
  onFiles: (files: File[]) => void
  items: WatchItem[]
  timedOut: boolean
  onRearm: () => void
  missing: string[]
  onDismissMissing: () => void
  /** The results of the last batch. */
  lastUploads: readonly KnowledgeUploadResult[]
}

const CORPUS_TYPES = new Set(['application/pdf', 'application/zip', 'application/x-zip-compressed'])

/** What the corpus takes: a PDF, or a ZIP of PDFs. */
export function isCorpusFile(file: File): boolean {
  return /\.(pdf|zip)$/i.test(file.name) || CORPUS_TYPES.has(file.type)
}

export function KnowledgeUploadPanel({
  open,
  isUploading,
  isBusy,
  onFiles,
  items,
  timedOut,
  onRearm,
  missing,
  onDismissMissing,
  lastUploads,
}: KnowledgeUploadPanelProps): JSX.Element {
  const t = useTranslations(platformCopy)
  const inputRef = useRef<HTMLInputElement>(null)

  const done = items.filter((item) => item.phase !== 'working').length
  const rejected = lastUploads.flatMap((upload) =>
    upload.kind === 'zip' ? (upload.members ?? []).filter((m) => m.status === 'rejected') : []
  )

  /** Hand on what the corpus takes, and say how many it left out. */
  const take = (files: File[]) => {
    const accepted = files.filter(isCorpusFile)
    const skipped = files.length - accepted.length
    if (skipped > 0) toast.warning(t('knowledge.dropSkipped', { count: skipped }))
    if (accepted.length > 0) onFiles(accepted)
  }
  const { isDragging, refusal, dragHandlers } = useFileDragDrop({
    onDrop: (files) => take(files),
    refusal: isBusy ? t('knowledge.dropBusy') : null,
  })
  useWindowDragGuard()

  return (
    <>
      {/* Outside the dropzone: the panel collapses, and an input that unmounts
          mid-upload would cancel its change event. */}
      <input
        ref={inputRef}
        type="file"
        accept=".pdf,.zip,application/zip,application/pdf"
        multiple
        className="hidden"
        data-testid="knowledge-upload-input"
        onChange={(event) => {
          const files = Array.from(event.target.files ?? [])
          event.target.value = ''
          take(files)
        }}
      />

      {open ? (
        <button
          type="button"
          aria-disabled={isBusy || undefined}
          aria-describedby="knowledge-dropzone-hint"
          onClick={() => {
            if (isBusy) {
              toast.info(t('knowledge.dropBusy'))
              return
            }
            inputRef.current?.click()
          }}
          {...dragHandlers}
          data-dragging={isDragging || undefined}
          className={cn(
            'flex min-h-32 w-full flex-col items-center justify-center gap-1.5 rounded-lg border border-dashed px-4 py-6 text-center',
            'duration-quick transition-colors ease-out motion-reduce:transition-none',
            'animate-in fade-in-0 duration-base ease-out motion-reduce:animate-none',
            'focus-visible:ring-ring/60 focus-visible:outline-none focus-visible:ring-2',
            isDragging && refusal && 'border-destructive bg-destructive/5',
            isDragging && !refusal && 'border-foreground/40 bg-accent',
            !isDragging && 'bg-muted/25 hover:bg-accent/50',
            isBusy ? 'cursor-progress opacity-70' : 'cursor-pointer'
          )}
          data-testid="knowledge-dropzone"
        >
          {isUploading ? (
            <Spinner size="sm" className="text-muted-foreground" aria-hidden />
          ) : (
            <Upload className="text-muted-foreground size-5" aria-hidden />
          )}
          <span className="text-foreground text-sm font-medium">
            {refusal ??
              (isUploading
                ? t('knowledge.uploading')
                : isDragging
                  ? t('knowledge.dropActive')
                  : t('knowledge.dropTitle'))}
          </span>
          <span id="knowledge-dropzone-hint" className="text-muted-foreground text-xs">
            {t('knowledge.dropHint')}
          </span>
        </button>
      ) : null}

      {items.length > 0 && !timedOut ? (
        <div
          className="bg-muted/25 flex flex-col gap-2.5 rounded-lg border p-4"
          data-testid="knowledge-upload-progress"
          aria-live="polite"
        >
          <div className="flex items-center gap-2">
            <Spinner size="xs" className="text-muted-foreground shrink-0" aria-hidden />
            <p className="text-foreground text-sm font-medium">
              {t('knowledge.indexingProgress', { done, total: items.length })}
            </p>
          </div>
          <Progress
            value={Math.round((done / items.length) * 100)}
            aria-label={t('knowledge.processing')}
          />
          <p className="text-muted-foreground text-xs">{t('knowledge.processingHint')}</p>
          {items.length > 1 ? (
            <ScrollArea className="max-h-40 pr-1">
              <ul className="flex flex-col gap-1.5">
                {items.map((item) => (
                  <li key={item.name} className="flex items-center justify-between gap-2 text-xs">
                    <span className="text-foreground min-w-0 truncate">{item.name}</span>
                    <WatchBadge item={item} />
                  </li>
                ))}
              </ul>
            </ScrollArea>
          ) : null}
        </div>
      ) : null}

      {/* The ceiling was reached with files still working: a persistent notice
          with a way to keep watching, instead of a bar that just vanishes. */}
      {timedOut ? (
        <Alert variant="info" data-testid="knowledge-poll-timeout">
          <AlertCircle aria-hidden />
          <AlertTitle className="line-clamp-none">{t('knowledge.pollTimeoutTitle')}</AlertTitle>
          <AlertDescription className="flex flex-col items-start gap-2">
            <span>{t('knowledge.pollTimeoutDescription')}</span>
            <Button variant="outline" size="sm" onClick={onRearm}>
              <RefreshCw className="size-3.5" aria-hidden />
              {t('knowledge.pollTimeoutRefresh')}
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}

      {missing.length > 0 ? (
        <Alert variant="warning" data-testid="knowledge-missing">
          <AlertCircle aria-hidden />
          <AlertTitle className="line-clamp-none">
            {t('knowledge.missingTitle', { count: missing.length })}
          </AlertTitle>
          <AlertDescription className="flex flex-col items-start gap-2">
            <span>{t('knowledge.missingDescription')}</span>
            <ul className="list-disc space-y-0.5 pl-4">
              {missing.map((name) => (
                <li key={name} className="break-all font-mono text-xs">
                  {name}
                </li>
              ))}
            </ul>
            <Button variant="outline" size="sm" onClick={onDismissMissing}>
              {t('knowledge.missingDismiss')}
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}

      {rejected.length > 0 ? (
        <Alert variant="warning">
          <AlertCircle aria-hidden />
          <AlertTitle className="line-clamp-none">{t('knowledge.zipRejectedTitle')}</AlertTitle>
          <AlertDescription>
            <ul className="mt-1 list-disc space-y-0.5 pl-4">
              {rejected.map((member) => (
                <li key={member.fileName}>
                  <span className="font-medium">{member.fileName}</span>
                  {member.reason ? `: ${member.reason}` : ''}
                </li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      ) : null}
    </>
  )
}

function WatchBadge({ item }: { item: WatchItem }): JSX.Element {
  const t = useTranslations(platformCopy)
  if (item.phase === 'missing')
    return <Badge variant="warning">{t('knowledge.indexingMissing')}</Badge>
  if (item.phase === 'done' && item.state) return <KnowledgeStateBadge state={item.state} />
  return (
    <Badge variant="info" className="gap-1">
      <Spinner size="xs" aria-hidden />
      {t('knowledge.indexingPending')}
    </Badge>
  )
}
