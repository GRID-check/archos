'use client'

import { useState, type JSX } from 'react'
import { FileDown, History, Unlink } from 'lucide-react'
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
import { bimCopy } from '@/i18n/namespaces/bim'
import { capturePosthog } from '@/lib/analytics/posthog'
import { ANNOTATION_EXPORT_SCOPES, type AnnotationExportScope } from '@/lib/annotations/export-request'
import type { AnnotationView } from '@/lib/annotations/types'
import { bcf3ExportHref } from '@/lib/bim/bcf3-wire'
import { downloadFetched } from '@/lib/browser-download'
import type { ModelMarks } from '../hooks/use-model-marks'

/**
 * Where a mark on a model stands against the model's newer Fassung, under its
 * row and above its thread: how many of its elements that Fassung still has,
 * by GlobalId, with „übernehmen“ where the server says this reader's carry goes
 * through (`carryTarget`); or that none of them is left and it keeps its last
 * view (`anchorLost`). Nothing for a mark on the current Fassung.
 */
export function ModelMarkCarry({ marks, annotation }: { marks: ModelMarks; annotation: AnnotationView }): JSX.Element | null {
  const t = useTranslations(bimCopy)
  const [busy, setBusy] = useState(false)
  const target = annotation.carryTarget ?? null
  const elements = target?.elements ?? null
  if (!elements && !annotation.anchorLost) return null
  const number = target?.revisionNumber ?? null
  const across = target !== null && target.documentId !== annotation.documentId
  const where = across ? t('marks.carry.inDocument', { name: target.documentName }) : number ? t('marks.carry.inRevision', { number }) : t('marks.carry.inCurrent')
  const carry = async () => {
    setBusy(true)
    await marks.carry(annotation)
    setBusy(false)
  }
  return (
    <div className="text-muted-foreground flex flex-col gap-1.5 text-xs leading-5" data-testid="mark-carry">
      {annotation.anchorLost && (
        <p className="flex items-start gap-1.5" data-testid="mark-carry-lost">
          <Unlink className="mt-1 size-3 shrink-0" aria-hidden />
          {t('marks.carry.lost')}
        </p>
      )}
      {elements && (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <p className="flex items-start gap-1.5" data-testid="mark-carry-count">
            <History className="mt-1 size-3 shrink-0" aria-hidden />
            {elements.total === 0
              ? t('marks.carry.wholeView', { where })
              : elements.present === 0
                ? t('marks.carry.none', { total: elements.total, where })
                : t('marks.carry.present', { present: elements.present, total: elements.total, where })}
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-6 px-2 text-xs"
            disabled={busy}
            data-testid="mark-carry-button"
            onClick={() => void carry()}
          >
            {t('marks.carry.button')}
          </Button>
        </div>
      )}
    </div>
  )
}

/**
 * „Als BCF exportieren“: the model's Anmerkungen as a BCF 3.0 file for the
 * Fachplaner's BIM tool, the open ones or all of them, from the route the door
 * offers agents (`document-annotations-bcf-export`). Fetched rather than
 * navigated to, as the Protokoll is: a refusal is a toast, not a JSON file in
 * the downloads folder.
 */
export function ModelMarksExport({ documentId }: { documentId: string }): JSX.Element {
  const t = useTranslations(bimCopy)
  const [busy, setBusy] = useState(false)
  const download = async (scope: AnnotationExportScope) => {
    setBusy(true)
    const result = await downloadFetched(bcf3ExportHref(documentId, scope), 'anmerkungen.bcf')
    setBusy(false)
    if (result.saved) capturePosthog('report_exported', { kind: 'annotations', format: 'bcf' })
    else toast.error(t('marks.export.failed'))
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="ghost" size="sm" className="h-7 gap-1.5 px-2 text-xs" disabled={busy} data-testid="marks-export">
          <FileDown className="size-3.5" aria-hidden />
          {t('marks.export.button')}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56" data-testid="marks-export-menu">
        <DropdownMenuLabel className="text-xs font-normal">{t('marks.export.label')}</DropdownMenuLabel>
        {ANNOTATION_EXPORT_SCOPES.map((scope) => (
          <DropdownMenuItem key={scope} data-testid={`marks-export-${scope}`} onSelect={() => void download(scope)}>
            {t(`marks.export.${scope}`)}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
