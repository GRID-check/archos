'use client'

/**
 * What Piloti showed the person in their viewer during this answer (ADR-0144).
 *
 * One line per viewer action: the place, what became of it, and the one
 * control that fits. Moved: „Zurück“ puts the viewer back as it was. Not moved
 * (the person turned it off, was typing, or the action would cover or leave the
 * chat): „Anzeigen“ runs it now. A document the person may not see says so and
 * offers nothing. The switch beside them is the person's choice whether Piloti
 * opens places on its own; it starts off under reduced motion.
 *
 * Only the asker's page has rows: the actions are kept for the turns it asked
 * (`viewer-actions.ts`), and none is stored with the answer, so a spectator or
 * a reload sees the answer without them.
 */

import { useId, type FC } from 'react'
import { ArrowUpRight, Box, Columns2, Highlighter, SquareDashed } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { useTranslations } from '@/i18n'
import {
  autoPreference,
  setViewerActionsAuto,
  showViewerAction,
  undoViewerAction,
  useViewerActionStore,
  viewerActionsOf,
  type ViewerActionEntry,
  type ViewerActionName,
} from '../lib/viewer-actions'

const ICONS: Record<ViewerActionName, typeof ArrowUpRight> = {
  open_document: ArrowUpRight,
  highlight_passage: Highlighter,
  highlight_region: SquareDashed,
  compare_revisions: Columns2,
  focus_ifc_element: Box,
}

type T = ReturnType<typeof useTranslations>

/** „Baubeschreibung.pdf, S. 4“, „Bereich in Grundriss EG.pdf, S. 1“, „Grundriss EG mit … vergleichen“. */
export const describeViewerAction = (t: T, entry: ViewerActionEntry): string => {
  const { tool_call_name: name, args } = entry.call
  const place = args.page ? t('viewerActions.place', { name: args.document_name, page: args.page }) : args.document_name
  return t(`viewerActions.what.${name}`, {
    place,
    name: args.document_name,
    against: args.against_document_name ?? '',
  })
}

const statusText = (t: T, entry: ViewerActionEntry): string =>
  entry.status === 'offered' ? t(`viewerActions.offered.${entry.reason ?? 'off'}`) : t(`viewerActions.status.${entry.status}`)

const Row: FC<{ entry: ViewerActionEntry }> = ({ entry }) => {
  const t = useTranslations('chat')
  const Icon = ICONS[entry.call.tool_call_name]
  const what = describeViewerAction(t, entry)
  const id = entry.call.tool_call_id
  return (
    <li className="flex min-w-0 items-start gap-2 text-xs" data-testid="viewer-action" data-status={entry.status}>
      <Icon className="mt-0.5 size-3.5 shrink-0 text-info" aria-hidden="true" />
      {/* Wraps rather than truncates: on a phone the file name and the outcome are the whole message. */}
      <span className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2 leading-5">
        <span className="font-medium text-foreground [overflow-wrap:anywhere]">{what}</span>
        <span className="text-muted-foreground">{statusText(t, entry)}</span>
      </span>
      {entry.status === 'shown' && (
        <Button
          variant="ghost"
          size="sm"
          className="h-6 shrink-0 px-2"
          aria-label={t('viewerActions.undoAria', { what })}
          onClick={() => undoViewerAction(id)}
        >
          {t('viewerActions.undo')}
        </Button>
      )}
      {(entry.status === 'offered' || entry.status === 'undone') && (
        <Button
          variant="outline"
          size="sm"
          className="h-6 shrink-0 px-2"
          aria-label={t('viewerActions.showAria', { what })}
          onClick={() => void showViewerAction(id)}
        >
          {t('viewerActions.show')}
        </Button>
      )}
    </li>
  )
}

export const ViewerActionRow: FC<{ messageId: string }> = ({ messageId }) => {
  const t = useTranslations('chat')
  const switchId = useId()
  const entries = useViewerActionStore(useShallow((state) => viewerActionsOf(state, messageId)))
  const auto = useViewerActionStore(autoPreference)
  const carriesSwitch = useViewerActionStore((state) => state.latestAnswer === messageId)
  if (entries.length === 0) return null
  return (
    <section
      aria-label={t('viewerActions.region')}
      // Announced as it changes: the person hears that their viewer moved, and where.
      aria-live="polite"
      className="flex flex-col gap-1.5 rounded-md bg-info-subtle px-2.5 py-2"
      data-testid="viewer-action-row"
    >
      <ul className="flex flex-col gap-1">
        {entries.map((entry) => (
          <Row key={entry.call.tool_call_id} entry={entry} />
        ))}
      </ul>
      {carriesSwitch && (
      <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
        <Switch
          id={switchId}
          checked={auto}
          onCheckedChange={setViewerActionsAuto}
          aria-describedby={`${switchId}-hint`}
        />
        <label htmlFor={switchId} className="font-medium text-foreground">
          {t('viewerActions.auto')}
        </label>
        <span id={`${switchId}-hint`} className="sr-only">
          {t('viewerActions.autoHint')}
        </span>
      </div>
      )}
    </section>
  )
}
