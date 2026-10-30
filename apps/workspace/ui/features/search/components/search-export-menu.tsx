'use client'

import type { JSX } from 'react'
import { Download, FileSpreadsheet, FileText } from 'lucide-react'

import { ActionMenu } from '@/components/ui/action-menu'
import { Button } from '@/components/ui/button'
import { useTranslations } from '@/i18n'
import { searchCopy } from '@/i18n/namespaces/search'
import type { SearchExportFormat } from '@/adapters/api/search-client'

/**
 * The Planliste of the current result, as CSV or XLSX, with every column of
 * the register. Offered in the register view only, where the Planliste is on
 * screen: an icon in the toolbar, as Dateien sets its secondary actions.
 */
export function SearchExportMenu({
  onExport,
  busy,
}: {
  onExport: (format: SearchExportFormat) => void
  busy: boolean
}): JSX.Element {
  const t = useTranslations(searchCopy, 'export')
  return (
    <ActionMenu
      mode="dropdown"
      entries={[
        { type: 'item', id: 'csv', label: t('csv'), icon: FileText, onSelect: () => onExport('csv'), testId: 'search-export-csv' },
        { type: 'item', id: 'xlsx', label: t('xlsx'), icon: FileSpreadsheet, onSelect: () => onExport('xlsx'), testId: 'search-export-xlsx' },
        // The file's columns are fixed (`plan-list-export.ts`), whatever the
        // register shows: said here, where the reader decides, not in a tooltip.
        { type: 'separator' },
        { type: 'label', label: t('allColumns') },
      ]}
      trigger={
        <Button type="button" variant="ghost" size="icon" aria-label={t('label')} title={t('label')} aria-busy={busy || undefined} disabled={busy} data-testid="search-export">
          <Download aria-hidden />
        </Button>
      }
    />
  )
}
