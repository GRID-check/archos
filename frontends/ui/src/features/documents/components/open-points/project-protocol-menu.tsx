'use client'

import { useState, type JSX } from 'react'
import { FileDown } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useTranslations } from '@/i18n'
import { capturePosthog } from '@/lib/analytics/posthog'
import { downloadFetched } from '@/lib/browser-download'
import { ANNOTATION_EXPORT_FORMATS, type AnnotationExportFormat } from '@/lib/annotations/export-request'
import { projectProtocolHref, type ProjectMarksFilters } from '@/lib/annotations/project-types'

/**
 * „Protokoll exportieren" over a project's Offene Punkte: the marks the list
 * shows, under its filters, as one file across the documents
 * (`/api/projects/{id}/annotations/export`), downloaded the way a document's
 * Protokoll is (`downloadFetched`). Only the format is asked: what is in it
 * is what is on screen.
 */
export function ProjectProtocolMenu({
  projectId,
  filters,
}: {
  projectId: string
  filters: ProjectMarksFilters
}): JSX.Element {
  const t = useTranslations('files')
  const [busy, setBusy] = useState(false)

  const download = async (format: AnnotationExportFormat): Promise<void> => {
    setBusy(true)
    const result = await downloadFetched(projectProtocolHref(projectId, filters, format), `protokoll.${format}`)
    setBusy(false)
    if (result.saved) {
      // The CSAT trigger the document's Protokoll fires: the kind and the format, never a name or a filter.
      capturePosthog('report_exported', { kind: 'open_points', format })
      return
    }
    toast.error(
      result.reason === 'too-many-marks'
        ? t('openPoints.export.tooMany')
        : result.status === 422 && format === 'pdf'
          ? t('review.export.tooLongForPdf')
          : t('openPoints.export.failed')
    )
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="outline" size="sm" className="gap-1.5" disabled={busy}
          title={t('openPoints.export.hint')}
          data-testid="open-points-export"
        >
          <FileDown className="size-3.5" aria-hidden />
          {t('openPoints.export.button')}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60" data-testid="open-points-export-menu">
        <DropdownMenuLabel>{t('openPoints.export.formatLabel')}</DropdownMenuLabel>
        {ANNOTATION_EXPORT_FORMATS.map((format) => (
          <DropdownMenuItem key={format} onSelect={() => void download(format)} data-testid={`open-points-export-${format}`}>
            {t(`review.export.formats.${format}`)}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
