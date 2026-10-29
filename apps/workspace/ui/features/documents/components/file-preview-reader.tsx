'use client'

import type { JSX } from 'react'

import { useState, useEffect, type ReactNode } from 'react'

import { toast } from 'sonner'
import type { FileItem } from './project-file-workspace'
import { ListTree, MessageSquarePlus, MessageSquareText, ShieldOff, Trash2, X } from 'lucide-react'

import { ApiRequestError } from '@/adapters/api/api-error'
import { getQuarantineReviewAccess, releaseQuarantinedDocument, type QuarantineReviewAccess } from '@/adapters/api/upload-screening-client'
import { notifyDocumentsChanged } from '@/lib/documents/document-changes'

import { RequestReviewButton } from './request-review-button'

import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'

import { useTranslations } from '@/i18n'
import { commonCopy } from '@/i18n/namespaces/common'
import { filesCopy } from '@/i18n/namespaces/files'
import { organizationCopy } from '@/i18n/namespaces/organization'

import { cn } from '@/lib/utils'

import { MiddleTruncate } from '@/components/ui/middle-truncate'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { DeleteDocumentDialog, type DocumentActions, type DocumentScope } from './document-actions'

import { AssignPopover } from './assign-popover'
import { useRouter } from 'next/navigation'

import { askAboutFile } from '../lib/ask-about-file'

import { CountPill } from '@/components/ui/count-pill'

/**
 * What this reader can do about a held file, under its findings (ADR-0086).
 *
 * A reviewer allows it or deletes it here, looking at the page the check found
 * it on, with the same question the Quarantäne list asks. The uploader who may
 * not decide asks those who may. Which of the two is the server's answer
 * (`GET /api/documents/{id}/quarantine`), never a role read here; until it
 * lands, and for anyone else, nothing is offered.
 */
export function HeldReview({
  documentId,
  scope,
  actions,
  onReleased,
}: {
  documentId: string
  scope: DocumentScope
  /** The pane's document actions: its name, and the delete the menu uses. */
  actions: DocumentActions
  /** The file was allowed and sent to be read, with this status. */
  onReleased: (status: string) => void
}): JSX.Element | null {
  const t = useTranslations(filesCopy)
  const tOrg = useTranslations(organizationCopy)
  const tc = useTranslations(commonCopy)
  const [access, setAccess] = useState<QuarantineReviewAccess | null>(null)
  const [releaseOpen, setReleaseOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)

  useEffect(() => {
    const controller = new AbortController()
    getQuarantineReviewAccess(documentId, controller.signal)
      .then(setAccess)
      .catch(() => {
        // Not knowing offers nothing: both actions check for themselves anyway.
        if (!controller.signal.aborted) setAccess({ canReview: false, canAskForReview: false })
      })
    return () => controller.abort()
  }, [documentId])

  const release = async (): Promise<void> => {
    try {
      const { status } = await releaseQuarantinedDocument(documentId)
      notifyDocumentsChanged()
      toast.success(tOrg('quarantine.released', { name: actions.name }))
      onReleased(status)
    } catch (error) {
      // Someone else allowed or deleted it first: what was on screen was stale.
      const decided = error instanceof ApiRequestError && (error.status === 409 || error.status === 404)
      if (decided) notifyDocumentsChanged()
      toast.error(decided ? t('preview.heldDecided') : tOrg('quarantine.releaseError'))
    }
  }

  if (access?.canAskForReview) {
    return <RequestReviewButton documentId={documentId} name={actions.name} testId="preview-held-request-review" />
  }
  if (!access?.canReview) return null

  return (
    <>
      <div className="flex flex-wrap items-center gap-2" data-testid="preview-held-review">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setReleaseOpen(true)}
          data-testid="preview-held-release"
        >
          {tOrg('quarantine.release')}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => setDeleteOpen(true)}
          disabled={actions.isDeleting}
          data-testid="preview-held-delete"
        >
          <Trash2 className="size-4" aria-hidden />
          {tOrg('quarantine.delete')}
        </Button>
      </div>
      <ConfirmDialog
        open={releaseOpen}
        onOpenChange={setReleaseOpen}
        title={tOrg('quarantine.releaseTitle', { name: actions.name })}
        description={tOrg('quarantine.releaseDescription')}
        confirmLabel={tOrg('quarantine.release')}
        cancelLabel={tc('actions.cancel')}
        tone="warning"
        icon={ShieldOff}
        confirmTestId="preview-held-release-confirm"
        onConfirm={release}
      />
      <DeleteDocumentDialog open={deleteOpen} onOpenChange={setDeleteOpen} scope={scope} actions={actions} />
    </>
  )
}

export function AskColleagueButton({
  projectId,
  file,
  documentId,
}: {
  projectId: string
  file: FileItem
  documentId: string
}): JSX.Element {
  const t = useTranslations(filesCopy)
  const router = useRouter()
  return (
    <AssignPopover
      documentId={documentId}
      assignees={file.assignees ?? []}
      pickOnly
      onPick={(person) => {
        const name = person.name || person.email || t('assignment.to')
        askAboutFile({
          projectId,
          file,
          ask: `@${name} `,
          mentions: [{ targetId: person.userId, display: name }],
          navigate: (href) => router.push(href),
        })
      }}
      onChanged={() => undefined}
      // Full width in the rail, beside „Piloti dazu fragen", rather than the
      // ghost pill the popover draws for the Files list. The two Ask affordances
      // are one pair and have to read as one.
      trigger={
        <Button type="button" variant="outline" size="sm" className="h-8 w-full">
          {t('assignment.askColleague')}
        </Button>
      }
    />
  )
}

/**
 * The reader's header on a phone: the document's name across the whole width,
 * cut in the MIDDLE so a revision suffix (`…_1OG_C.pdf`) survives, the facts
 * and the state chips under it, and the close where every full-screen surface
 * on a phone keeps it. Nothing else competes with the name for the row; on a
 * phone on its side the actions join it, because there is no height for a bar.
 */
export function ReaderHeader({
  name,
  title,
  facts,
  contentType,
  status,
  actions,
  closeLabel,
  onClose,
}: {
  name: string
  title: string
  facts: string | null
  contentType: string | null | undefined
  status: ReactNode
  actions: ReactNode
  closeLabel: string
  onClose?: () => void
}): JSX.Element {
  return (
    <div
      data-testid="file-reader-header"
      className="bg-card flex shrink-0 items-center gap-2 border-b pt-[max(0.375rem,env(safe-area-inset-top))] pr-[max(0.25rem,env(safe-area-inset-right))] pb-1.5 pl-[max(1rem,env(safe-area-inset-left))]"
    >
      <div className="min-w-0 flex-1 py-1">
        <h3 className="text-foreground flex text-[15px] font-medium leading-tight tracking-[-0.01em]" title={title}>
          <MiddleTruncate text={name} />
        </h3>
        <div className="mt-1 flex min-w-0 items-center gap-1.5 overflow-hidden">
          {facts && (
            <span
              className="text-muted-foreground min-w-0 shrink truncate text-xs tabular-nums"
              title={contentType ?? undefined}
              data-testid="file-preview-facts"
            >
              {facts}
            </span>
          )}
          {status}
        </div>
      </div>
      {actions}
      {onClose && (
        <Button
          variant="ghost"
          size="icon"
          className="size-11 shrink-0 rounded-full"
          onClick={onClose}
          aria-label={closeLabel}
          data-testid="file-reader-close"
        >
          <X className="size-5" aria-hidden />
        </Button>
      )}
    </div>
  )
}

/**
 * What acts on the document from the reader: its details, the conversation
 * about it, and the file's own menu (download, rename, delete). One set of controls in two
 * places: a bar at the thumb in portrait, a cluster in the header on its side.
 * The details are a sheet over the document rather than a scroll under it, so
 * the drawing keeps the screen while the reader checks its Fassung.
 */
export interface ReaderAnnotate {
  label: string
  /** Live marks; none shows „Anmerken" alone. */
  count: number
  /** The count in words, for a screen reader. */
  countLabel: string
  onClick: () => void
}

export function ReaderActions({
  layout,
  detailsLabel,
  detailsOpen,
  onDetails,
  annotate,
  discuss,
  menu,
}: {
  layout: 'bar' | 'header'
  detailsLabel: string
  detailsOpen: boolean
  onDetails: () => void
  /** The document's marks, where it can carry them. */
  annotate: ReaderAnnotate | null
  discuss: ReactNode
  menu: ReactNode
}): JSX.Element {
  const bar = layout === 'bar'
  return (
    <div
      data-testid={bar ? 'file-reader-bar' : 'file-reader-actions'}
      className={cn(
        'flex items-center',
        bar
          ? 'bg-card shrink-0 gap-2 border-t pt-2 pr-[max(0.75rem,env(safe-area-inset-right))] pb-[max(0.5rem,env(safe-area-inset-bottom))] pl-[max(0.75rem,env(safe-area-inset-left))]'
          : 'shrink-0 gap-1',
      )}
    >
      <Button
        type="button"
        variant="outline"
        size={bar ? 'default' : 'sm'}
        className={cn(
          'gap-1.5',
          bar ? 'h-11' : 'h-9 pointer-coarse:h-11',
          bar && annotate && 'max-[27.5rem]:w-11 max-[27.5rem]:px-0',
          bar && !discuss && 'flex-1'
        )}
        aria-expanded={detailsOpen}
        aria-haspopup="dialog"
        onClick={onDetails}
        data-testid="file-reader-details"
      >
        <ListTree className="size-4" aria-hidden />
        {/* Three actions and the menu do not fit a 393px bar in words: the two
            beside „Besprechen" keep their glyphs and give their names to a
            screen reader. */}
        <span className={cn(bar && annotate && 'max-[27.5rem]:sr-only')}>{detailsLabel}</span>
      </Button>
      {annotate && (
        <Button
          type="button"
          variant="outline"
          size={bar ? 'default' : 'sm'}
          className={cn('gap-1.5', bar ? 'h-11 min-w-11 shrink-0 px-3' : 'h-9 pointer-coarse:h-11')}
          // On a narrow bar the words give way to the glyph and the count, so
          // „Besprechen" keeps its label; the name stays for a screen reader.
          aria-label={annotate.count > 0 ? annotate.countLabel : annotate.label}
          onClick={annotate.onClick}
          data-testid="file-reader-annotate"
        >
          {annotate.count > 0 ? <MessageSquareText className="size-4" aria-hidden /> : <MessageSquarePlus className="size-4" aria-hidden />}
          <span className={cn('truncate', bar && 'max-[27.5rem]:sr-only')}>{annotate.label}</span>
          {annotate.count > 0 && <CountPill aria-hidden count={annotate.count} />}
        </Button>
      )}
      {discuss}
      <span className="[&_[data-testid=document-actions-trigger]]:size-11 contents">{menu}</span>
    </div>
  )
}

/**
 * The rail, where it lives: beside or under the document on a wide screen,
 * and in a sheet from the bottom edge in the phone reader, so it is one tap
 * away without ever taking the document's height.
 */
export function ReaderDetails({
  sheet,
  open,
  onOpenChange,
  title,
  description,
  children,
}: {
  sheet: boolean
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description: string
  children: ReactNode
}): JSX.Element {
  if (!sheet) return <>{children}</>
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        data-testid="file-reader-details-sheet"
        className="bg-card max-h-[85dvh] gap-0 overflow-y-auto overscroll-contain rounded-t-2xl p-0"
      >
        <SheetHeader className="bg-card sticky top-0 z-[1] px-4 pt-4 pb-2">
          <SheetTitle className="text-base">{title}</SheetTitle>
          <SheetDescription className="sr-only">{description}</SheetDescription>
        </SheetHeader>
        {children}
      </SheetContent>
    </Sheet>
  )
}
