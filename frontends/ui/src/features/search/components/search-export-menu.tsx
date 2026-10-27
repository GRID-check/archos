'use client'

import type { JSX } from 'react'
import { Download, FileSpreadsheet, FileText } from 'lucide-react'

import { ActionMenu } from '@/components/ui/action-menu'
import { Button } from '@/components/ui/button'
import { useTranslations } from '@/i18n'
import type { SearchExportFormat } from '../lib/search-client'
import { ToolbarLabel } from './search-atoms'

/** The Planliste of the current result, as CSV or XLSX. */
export function SearchExportMenu({
  onExport,
  busy,
}: {
  onExport: (format: SearchExportFormat) => void
  busy: boolean
}): JSX.Element {
  const t = useTranslations('search.export')
  return (
    <ActionMenu
      mode="dropdown"
      entries={[
        { type: 'item', id: 'csv', label: t('csv'), icon: FileText, onSelect: () => onExport('csv'), testId: 'search-export-csv' },
        { type: 'item', id: 'xlsx', label: t('xlsx'), icon: FileSpreadsheet, onSelect: () => onExport('xlsx'), testId: 'search-export-xlsx' },
      ]}
      trigger={
        <Button type="button" variant="outline" size="sm" aria-label={t('label')} aria-busy={busy || undefined} disabled={busy} data-testid="search-export">
          <Download aria-hidden />
          <ToolbarLabel>{t('label')}</ToolbarLabel>
        </Button>
      }
    />
  )
}
