'use client'

import { useRef, useState, type JSX } from 'react'
import { useRouter } from 'next/navigation'
import { FileDown, FolderInput } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useTranslations } from '@/i18n'
import { filesCopy } from '@/i18n/namespaces/files'
import { capturePosthog } from '@/lib/analytics/posthog'
import { downloadFetched } from '@/lib/browser-download'
import {
  ANNOTATION_EXPORT_REVISIONS,
  ANNOTATION_EXPORT_FORMATS,
  ANNOTATION_EXPORT_SCOPES,
  annotationExportHref,
  type AnnotationExportRevision,
  type AnnotationExportFormat,
  type AnnotationExportScope,
} from '@/lib/annotations/export-request'
import { documentFilesHref } from '../../lib/document-question'
import {
  documentStem,
  fileProtocol,
  ProtocolFilingError,
  protocolFilingStem,
  type ProtocolFilingTarget,
} from '../../lib/protocol-filing'
import { reviewToast } from './review-toaster'

/** Choosing an option keeps the menu open: the choice is made before the download, not instead of it. */
const keepOpen = (event: Event) => event.preventDefault()

/**
 * „Protokoll exportieren": the Anmerkungen as a file for the Jour fixe, the
 * client or a consultant. Which marks (open, or all), which Fassung's record
 * when closed ones are wanted and the document has more than one, Piloti's
 * unreviewed proposals when there are any, then the format, which downloads.
 * What is still open is in it from every Fassung, each entry naming the one it
 * was set on: a new Index before the Jour fixe does not close the points on
 * the one before.
 *
 * Fetched rather than navigated to (`downloadFetched`, which the project's
 * Offene Punkte use too): a refusal (a PDF too long to lay out, access lost
 * meanwhile) is a toast, not a JSON file in the downloads folder.
 *
 * „Im Projekt ablegen" files the same export, with the same choices, as a
 * document of the project, in the folder of the document it is about
 * (`../../lib/protocol-filing.ts`), and the toast opens it. Offered where the
 * document is a project's and the reader may file into it (`filing`).
 */
export function ReviewExportMenu({
  documentId,
  hasRevisions,
  hasProposals,
  filing = null,
}: {
  documentId: string
  /** The document has earlier Fassungen, whose marks the export may carry too. */
  hasRevisions: boolean
  /** Piloti proposed marks nobody took over; they can be appended under their own heading. */
  hasProposals: boolean
  /** Where „Im Projekt ablegen" files it, and the document's name the file is named after; absent, it is not offered. */
  filing?: { target: ProtocolFilingTarget; documentName: string } | null
}): JSX.Element {
  const t = useTranslations(filesCopy)
  const [scope, setScope] = useState<AnnotationExportScope>('open')
  const [revision, setRevision] = useState<AnnotationExportRevision>('current')
  const [includeProposals, setIncludeProposals] = useState(false)
  const [busy, setBusy] = useState(false)
  const router = useRouter()
  /** What this tab filed, by name: a second filing of the same name the same day is a new Fassung of it. */
  const filedHere = useRef(new Map<string, string>())

  const optionsFor = (format: AnnotationExportFormat) =>
    ({
      format,
      scope,
      revision: hasRevisions && scope === 'all' ? revision : 'current',
      includeProposals: hasProposals && includeProposals,
    }) as const

  const download = async (format: AnnotationExportFormat): Promise<void> => {
    setBusy(true)
    const result = await downloadFetched(annotationExportHref(documentId, optionsFor(format)), `protokoll.${format}`)
    setBusy(false)
    if (result.saved) {
      // The CSAT trigger the answer and the BIM exports fire: the kind and the format, never the name.
      capturePosthog('report_exported', { kind: 'annotations', format })
      return
    }
    toast.error(
      result.status === 422 && format === 'pdf' ? t('review.export.tooLongForPdf') : t('review.export.failed'),
      reviewToast(),
    )
  }

  const file = async (target: ProtocolFilingTarget, documentName: string): Promise<void> => {
    setBusy(true)
    const stem = protocolFilingStem((values) => t('review.export.fileName', values), documentStem(documentName))
    try {
      const filed = await fileProtocol((format) => annotationExportHref(documentId, optionsFor(format)), target, stem)
      const again = filedHere.current.get(filed.filename) === filed.documentId
      filedHere.current.set(filed.filename, filed.documentId)
      const message = filed.unchanged
        ? t('review.export.filedUnchanged', { name: filed.filename })
        : again
          ? t('review.export.filedAgain', { name: filed.filename })
          : t('review.export.filed', { name: filed.filename })
      toast.success(
        message,
        reviewToast({
          action: {
            label: t('review.export.openFiled'),
            onClick: () => router.push(documentFilesHref(target.projectId, filed.documentId)),
          },
        })
      )
    } catch (error) {
      const taken = error instanceof ProtocolFilingError && error.reason === 'name-taken'
      toast.error(taken ? t('review.export.fileNameTaken', { name: stem }) : t('review.export.fileFailed'), reviewToast())
    } finally {
      setBusy(false)
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="outline" size="sm" className="h-8 gap-1.5" disabled={busy} data-testid="review-export">
          <FileDown className="size-3.5" aria-hidden />
          {t('review.export.button')}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60" data-testid="review-export-menu">
        <DropdownMenuLabel>{t('review.export.scopeLabel')}</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={scope} onValueChange={(value) => setScope(value as AnnotationExportScope)}>
          {ANNOTATION_EXPORT_SCOPES.map((option) => (
            <DropdownMenuRadioItem key={option} value={option} onSelect={keepOpen} data-testid={`review-export-scope-${option}`}>
              {t(`review.export.scopes.${option}`)}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        {/* Only for the record: open marks come from every Fassung whatever is
            chosen here (`selectMarks`), so with „Nur offene" the choice
            would change nothing and is not offered. */}
        {hasRevisions && scope === 'all' && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>{t('review.export.revisionLabel')}</DropdownMenuLabel>
            <DropdownMenuRadioGroup value={revision} onValueChange={(value) => setRevision(value as AnnotationExportRevision)}>
              {ANNOTATION_EXPORT_REVISIONS.map((option) => (
                <DropdownMenuRadioItem
                  key={option}
                  value={option}
                  onSelect={keepOpen}
                  data-testid={`review-export-revision-${option}`}
                >
                  {t(`review.export.revisions.${option}`)}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </>
        )}
        {hasProposals && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuCheckboxItem
              checked={includeProposals}
              onCheckedChange={(checked) => setIncludeProposals(checked === true)}
              onSelect={keepOpen}
              data-testid="review-export-proposals"
            >
              {t('review.export.includeProposals')}
            </DropdownMenuCheckboxItem>
          </>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuLabel>{t('review.export.formatLabel')}</DropdownMenuLabel>
        {ANNOTATION_EXPORT_FORMATS.map((format) => (
          // Inset to the radio items' text: one column of words down the menu.
          <DropdownMenuItem key={format} inset onSelect={() => void download(format)} data-testid={`review-export-${format}`}>
            {t(`review.export.formats.${format}`)}
          </DropdownMenuItem>
        ))}
        {filing && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={() => void file(filing.target, filing.documentName)}
              disabled={busy}
              data-testid="review-export-file"
            >
              <FolderInput aria-hidden />
              {busy ? t('review.export.filing') : t('review.export.fileInto')}
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
