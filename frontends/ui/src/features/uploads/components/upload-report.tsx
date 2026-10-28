'use client'

/**
 * The Eingangsbericht under an `upload.completed` inbox row: what the upload
 * brought the project, in three short lines, and „Zu den Befunden“ when it
 * brought any (`../lib/upload-report-copy`). Keyed on the data the row
 * carries (`item.uploadReport`), never on the row's type.
 *
 * The link sits above the row's stretched link (`relative z-10`), as the
 * row's other actions do.
 */

import type { JSX } from 'react'
import Link from 'next/link'
import { FileSearch } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslations } from '@/i18n'
import { dossierCopy } from '@/i18n/namespaces/dossier'
import type { UploadReport } from '@/lib/upload-batches/upload-report'
import { DOCUMENT_FINDINGS_ANCHOR } from '@/features/documents/components/document-findings-panel'
import { uploadReportCopy, uploadReportFindingsHref } from '../lib/upload-report-copy'

export function UploadReportLines({ report }: { report: UploadReport }): JSX.Element {
  const t = useTranslations(dossierCopy)
  const copy = uploadReportCopy(t, report)
  return (
    <section
      aria-label={t('uploadReport.label')}
      className="text-muted-foreground mt-1 flex flex-col gap-0.5 pl-2.5 text-sm leading-relaxed"
      data-testid="upload-report"
    >
      <p className="text-foreground">{copy.read}</p>
      {copy.findings && <p data-testid="upload-report-findings">{copy.findings}</p>}
      {copy.details.length > 0 && <p className="text-xs">{copy.details.join(' · ')}</p>}
      {report.newFindings > 0 && (
        <div className="relative z-10 mt-1">
          <Button asChild size="sm" variant="outline" className="h-7 text-xs">
            <Link href={uploadReportFindingsHref(report, DOCUMENT_FINDINGS_ANCHOR)} data-testid="upload-report-open-findings">
              <FileSearch aria-hidden />
              {t('uploadReport.open')}
            </Link>
          </Button>
        </div>
      )}
    </section>
  )
}
