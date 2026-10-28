'use client'

/**
 * The filing bar: Piloti's filing suggestions decided per target folder, one
 * line each, where every file a line would move is in view. It sits above the
 * grid and the list of a folder, in the upload tray, and on the setup page's
 * „Ablage“, so one component draws the per-folder decision everywhere.
 *
 * A line is a proposal (one per target folder): the folder's path in full,
 * „neu“ where the move creates it, how many files the one confirm moves, and
 * the answer, „Belassen“ and „Verschieben“ (or „Anlegen und verschieben“).
 * Hovering or focusing a line lights the cards and rows it would move
 * (`useLightWhile`), so nothing moves that the person did not see.
 *
 * Quiet: the card surface, one hairline, no shadow. Above a folder it appears
 * only when a target folder in view collects two files or more
 * ({@link filingBarEntries}); with one file per folder the chip on the file is
 * the shorter way.
 */

import { useId, useMemo, useState, type JSX } from 'react'
import { NewMark } from '@/components/ui/filing-chip'
import {
  SuggestionActions,
  SuggestionButton,
  SuggestionNote,
  SuggestionPanel,
  SuggestionPanelHeader,
  SuggestionPanelLine,
  SuggestionPanelSubject,
} from '@/components/ui/suggestion-panel'
import { useTranslations } from '@/i18n'
import { filesCopy } from '@/i18n/namespaces/files'
import { filingBarEntries, type FilingFolderSuggestion } from '../lib/filing-suggestions'
import { useFilingDecision, useFilingSuggestionsContext, useLightWhile } from './filing-suggestion'

export function FilingBar({
  entries,
  onSettled,
  showNames = false,
  className,
}: {
  entries: readonly FilingFolderSuggestion[]
  /** A line was decided: re-read the suggestions (and the listing). */
  onSettled: () => void
  /** Name the files under each folder: for a page that shows no cards to light (the setup page). */
  showNames?: boolean
  className?: string
}): JSX.Element | null {
  const t = useTranslations(filesCopy)
  const headingId = useId()
  if (entries.length === 0) return null
  const total = entries.reduce((sum, entry) => sum + entry.suggestion.fileCount, 0)
  return (
    <SuggestionPanel aria-labelledby={headingId} className={className} data-testid="filing-bar">
      <SuggestionPanelHeader id={headingId}>{t('filing.barHeading', { count: total })}</SuggestionPanelHeader>
      {entries.map((entry) => (
        <FilingBarLine key={entry.suggestion.proposalId} entry={entry} onSettled={onSettled} showNames={showNames} />
      ))}
    </SuggestionPanel>
  )
}

function FilingBarLine({
  entry: { suggestion, documents },
  onSettled,
  showNames,
}: {
  entry: FilingFolderSuggestion
  onSettled: () => void
  showNames: boolean
}): JSX.Element {
  const t = useTranslations(filesCopy)
  const decision = useFilingDecision(suggestion, onSettled)
  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)
  const ids = useMemo(() => documents.map((document) => document.id), [documents])
  const active = (hovered || focused) && decision.outcome === null
  useLightWhile(active, ids)
  const names = documents.map((document) => document.name).join(', ')

  return (
    <SuggestionPanelLine
      active={active}
      data-testid="filing-bar-line"
      data-status={decision.status}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(false)
      }}
    >
      <SuggestionPanelSubject
        name={suggestion.folder}
        mark={suggestion.isNew ? <NewMark>{t('filing.new')}</NewMark> : undefined}
        count={t('filing.fileCount', { count: suggestion.fileCount })}
        detail={showNames ? names : undefined}
        detailTitle={names}
      />
      <SuggestionActions>
        {decision.outcome ? (
          <SuggestionNote
            tone={decision.status === 'failed' ? 'error' : 'default'}
            title={decision.failure ?? undefined}
            data-testid="filing-outcome"
          >
            {decision.outcome}
          </SuggestionNote>
        ) : decision.mayDecide ? (
          <>
            {decision.error && <SuggestionNote tone="error">{decision.error}</SuggestionNote>}
            <SuggestionButton
              variant="ghost"
              loading={decision.busy?.action === 'dismiss'}
              aria-disabled={decision.busy !== null}
              onClick={decision.dismiss}
              data-testid="filing-bar-dismiss"
            >
              {t('filing.keep')}
            </SuggestionButton>
            <SuggestionButton
              variant="outline"
              loading={decision.busy?.action === 'apply'}
              aria-disabled={decision.busy !== null}
              onClick={decision.apply}
              data-testid="filing-bar-apply"
            >
              {suggestion.isNew ? t('filing.createAndMove') : t('filing.move')}
            </SuggestionButton>
          </>
        ) : (
          <SuggestionNote>{t('filing.readOnly')}</SuggestionNote>
        )}
      </SuggestionActions>
    </SuggestionPanelLine>
  )
}

/**
 * The bar of a view: the provider's suggestions that move a document in it
 * (`documentIds`), when one target folder collects at least `minFiles` of them.
 * Draws nothing outside a provider or when there is nothing to decide per
 * folder; `className` places it.
 */
export function FilingViewBar({
  documentIds,
  minFiles = 2,
  className,
}: {
  documentIds: readonly string[]
  minFiles?: number
  className?: string
}): JSX.Element | null {
  const context = useFilingSuggestionsContext()
  const byFolder = context?.byFolder
  const key = documentIds.join('\u0000')
  const entries = useMemo(
    () => (byFolder ? filingBarEntries(byFolder, key === '' ? [] : key.split('\u0000'), minFiles) : []),
    [byFolder, key, minFiles]
  )
  if (!context || entries.length === 0) return null
  return (
    <div className={className}>
      <FilingBar entries={entries} onSettled={context.onSettled} />
    </div>
  )
}
