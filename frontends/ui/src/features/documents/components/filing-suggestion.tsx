'use client'

/**
 * Piloti's filing suggestion on the row of the file it is about: „Passt eher
 * in „Bescheide““, the reason in one line, and the person's answer, one click
 * to move it there and one to leave it. Not a second filing UI: the suggestion
 * is the server's proposed change (ADR-0105), read, applied and dismissed
 * through `useServerProposal`, the hook the chat's receipt cards use, so a
 * decision here is the same record, inbox item and Langfuse score as anywhere.
 *
 * One proposal per target folder: when it moves more files than this one, the
 * row says so and the button says how many it moves.
 *
 * The rows find their suggestion through {@link FilingSuggestionsProvider}, so
 * a list row, a card and an upload row need no new props; outside a provider
 * the slot draws nothing.
 */

import { createContext, useCallback, useContext, useMemo, type JSX, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { InlineSuggestion } from '@/components/ui/inline-suggestion'
import { useServerProposal, type ProposalOfKind } from '@/features/grid-cards/hooks/use-server-proposal'
import { useTranslations } from '@/i18n'
import type { FilingSuggestionView } from '../lib/filing-suggestions'

interface FilingSuggestionsContextValue {
  suggestionFor: (documentId: string) => FilingSuggestionView | undefined
  /** A suggestion was decided: re-read the listing and the suggestions. */
  onSettled: () => void
}

const FilingSuggestionsContext = createContext<FilingSuggestionsContextValue | null>(null)

export function FilingSuggestionsProvider({
  byDocument,
  onSettled,
  children,
}: {
  byDocument: ReadonlyMap<string, FilingSuggestionView>
  onSettled: () => void
  children: ReactNode
}): JSX.Element {
  const value = useMemo(
    () => ({ suggestionFor: (documentId: string) => byDocument.get(documentId), onSettled }),
    [byDocument, onSettled]
  )
  return <FilingSuggestionsContext.Provider value={value}>{children}</FilingSuggestionsContext.Provider>
}

/** The suggestion for one document, where a provider holds one; nothing otherwise. */
export function FilingSuggestionSlot({
  documentId,
  className,
}: {
  documentId: string | null | undefined
  className?: string
}): JSX.Element | null {
  const context = useContext(FilingSuggestionsContext)
  const suggestion = documentId ? context?.suggestionFor(documentId) : undefined
  if (!context || !suggestion) return null
  return (
    <FilingSuggestion key={suggestion.proposalId} suggestion={suggestion} onSettled={context.onSettled} className={className} />
  )
}

export function FilingSuggestion({
  suggestion,
  onSettled,
  className,
}: {
  suggestion: FilingSuggestionView
  onSettled: () => void
  className?: string
}): JSX.Element {
  const t = useTranslations('files')
  const settled = useCallback((_proposal: ProposalOfKind<'file_operation'>) => onSettled(), [onSettled])
  const { proposal, problem, busy, decide } = useServerProposal(suggestion.proposalId, 'file_operation', settled)
  const others = suggestion.fileCount - 1
  const title = suggestion.isNew
    ? t('filing.suggestionNew', { folder: suggestion.folder })
    : t('filing.suggestion', { folder: suggestion.folder })

  // Decided here or by a colleague: say so until the listing re-reads it away.
  if (proposal && proposal.status !== 'proposed') {
    const failed = proposal.status === 'failed'
    const moved = proposal.status === 'applied' || proposal.status === 'partially_applied'
    return (
      <InlineSuggestion
        className={className}
        data-testid="filing-suggestion"
        data-status={proposal.status}
        title={
          moved
            ? t('filing.moved', { folder: suggestion.folder })
            : failed
              ? t('filing.failed')
              : t('filing.kept')
        }
        detail={failed ? (proposal.results?.find((result) => !result.ok)?.reason ?? null) : null}
      />
    )
  }

  const mayDecide = proposal ? proposal.canDecide : suggestion.canDecide
  const reason = [suggestion.reason, others > 0 ? t('filing.others', { count: others }) : null]
    .filter(Boolean)
    .join(' · ')
  const moveLabel = suggestion.isNew
    ? t('filing.createAndMove')
    : others > 0
      ? t('filing.moveAll', { count: suggestion.fileCount })
      : t('filing.move')

  return (
    <InlineSuggestion
      className={className}
      data-testid="filing-suggestion"
      data-status="proposed"
      aria-label={t('filing.label')}
      title={<span title={title}>{title}</span>}
      detail={
        problem === 'apply' || problem === 'dismiss' ? (
          <span className="text-destructive">{t('filing.error')}</span>
        ) : !mayDecide ? (
          t('filing.readOnly')
        ) : reason ? (
          <span title={reason}>{reason}</span>
        ) : null
      }
      actions={
        mayDecide ? (
          <>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-auto min-h-7 max-w-full whitespace-normal px-2.5 py-1 text-left"
              loading={busy?.action === 'apply'}
              aria-disabled={busy !== null}
              onClick={() => void decide('apply')}
              data-testid="filing-suggestion-apply"
            >
              {moveLabel}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-7 px-2"
              loading={busy?.action === 'dismiss'}
              aria-disabled={busy !== null}
              onClick={() => void decide('dismiss')}
              data-testid="filing-suggestion-dismiss"
            >
              {t('filing.keep')}
            </Button>
          </>
        ) : null
      }
    />
  )
}
