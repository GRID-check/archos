'use client'

/**
 * The import of a coordination BCF file into the model's marks: a button above
 * the list and, once the server answered, one summary of what became of the
 * topics. The marks themselves arrive in the review's own list (a re-read);
 * nothing here keeps a list of its own.
 */

import { useCallback, useRef, useState, type JSX } from 'react'
import { FileUp } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { useTranslations } from '@/i18n'
import { bimCopy } from '@/i18n/namespaces/bim'
import { AnnotationRequestError, importAnnotationsBcf } from '@/lib/annotations/client'
import { BCF_IMPORT_EXTENSIONS, BCF_IMPORT_REFUSALS, type BcfImportResult } from '@/lib/bim/bcf-import-wire'

type ImportState = { kind: 'idle' } | { kind: 'running' } | { kind: 'done'; result: BcfImportResult } | { kind: 'refused'; reason: string }

/** The refusal's own sentence when the server named one this copy knows, else the general one. */
const KNOWN_REFUSALS: ReadonlySet<string> = new Set([...BCF_IMPORT_REFUSALS, 'model_not_ready'])

/** How many topics went for each reason, in the order reasons first appear. */
function byReason(entries: readonly { reason: string }[]): [string, number][] {
  const counts = new Map<string, number>()
  for (const entry of entries) counts.set(entry.reason, (counts.get(entry.reason) ?? 0) + 1)
  return [...counts]
}

function Summary({ result, onDismiss }: { result: BcfImportResult; onDismiss: () => void }): JSX.Element {
  const t = useTranslations(bimCopy)
  const groups = [
    { key: 'skipped', entries: result.skipped },
    { key: 'failed', entries: result.failed },
  ].filter((group) => group.entries.length > 0)
  return (
    <div className="text-muted-foreground flex items-start gap-2 text-xs leading-5" role="status" data-testid="marks-import-summary">
      <div className="min-w-0 flex-1">
        <p className="text-foreground">{t('marks.import.summary', { imported: result.imported.length, topics: result.topics })}</p>
        {groups.map((group) => (
          <p key={group.key}>
            {t(`marks.import.${group.key}`, { count: group.entries.length })}{' '}
            {byReason(group.entries)
              .map(([reason, count]) => `${count} × ${t(`marks.import.reason.${reason}`)}`)
              .join('; ')}
          </p>
        ))}
      </div>
      <Button type="button" variant="ghost" size="sm" className="-my-1 h-6 shrink-0 px-2 text-xs" onClick={onDismiss}>
        {t('marks.import.dismiss')}
      </Button>
    </div>
  )
}

/** The button and the summary; `onImported` re-reads the review's list. */
export function ModelMarksImport({ documentId, onImported }: { documentId: string; onImported: () => void }): JSX.Element {
  const t = useTranslations(bimCopy)
  const input = useRef<HTMLInputElement | null>(null)
  const [state, setState] = useState<ImportState>({ kind: 'idle' })

  const run = useCallback(
    async (file: File) => {
      setState({ kind: 'running' })
      try {
        const result = await importAnnotationsBcf(documentId, file)
        setState({ kind: 'done', result })
        if (result.imported.length > 0) onImported()
      } catch (error) {
        const reason = error instanceof AnnotationRequestError && error.reason && KNOWN_REFUSALS.has(error.reason) ? error.reason : 'generic'
        setState({ kind: 'refused', reason })
      }
    },
    [documentId, onImported]
  )

  return (
    <div className="flex flex-col gap-1.5" data-testid="marks-import">
      <input
        ref={input}
        type="file"
        accept={BCF_IMPORT_EXTENSIONS.join(',')}
        className="hidden"
        data-testid="marks-import-input"
        onChange={(event) => {
          const file = event.target.files?.[0]
          event.target.value = ''
          if (file) void run(file)
        }}
      />
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-7 gap-1.5 self-start text-xs"
        title={t('marks.import.hint')}
        disabled={state.kind === 'running'}
        onClick={() => input.current?.click()}
      >
        {state.kind === 'running' ? <Spinner size="sm" /> : <FileUp className="size-3.5" aria-hidden />}
        {state.kind === 'running' ? t('marks.import.running') : t('marks.import.action')}
      </Button>
      {state.kind === 'done' && <Summary result={state.result} onDismiss={() => setState({ kind: 'idle' })} />}
      {state.kind === 'refused' && (
        <p className="text-destructive text-xs leading-5" role="alert" data-testid="marks-import-refused">
          {t(`marks.import.refused.${state.reason}`)}
        </p>
      )}
    </div>
  )
}
