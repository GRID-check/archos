'use client'

/**
 * Piloti's filing suggestion on the file it is about: a chip („→ Bescheide“)
 * on the card's footer, after the name in the list, and on the upload row,
 * that opens the decision in a popover: the move as a before and an after, the
 * reason, and the answer, „Verschieben“ or „Belassen“.
 *
 * Not a second filing UI: the suggestion is the server's proposed change
 * (ADR-0105), read, applied and dismissed through `useServerProposal`, the hook
 * the chat's receipt cards use, so a decision here is the same record, inbox
 * item and Langfuse score as anywhere. The hook is mounted when the popover
 * opens, not with the chip: ten chips after a batch upload are ten quiet pills,
 * not ten reads and ten live channels.
 *
 * One proposal per target folder. When it moves more files than this one, the
 * popover says so and its button says how many it moves, and while it is open
 * the other files it moves are lit (`useFilingHighlighted`), so one file's
 * control never moves a file the person cannot see. The decision for several
 * files at once is the filing bar's (`filing-bar.tsx`).
 *
 * The chips find their suggestion through {@link FilingSuggestionsProvider}, so
 * a list row, a card and an upload row need no new props; outside a provider
 * a slot draws nothing.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type JSX,
  type ReactNode,
} from 'react'
import { FilingChip, NewMark } from '@/components/ui/filing-chip'
import { PathChange } from '@/components/ui/path-change'
import { Popover, PopoverTrigger } from '@/components/ui/popover'
import {
  SuggestionActions,
  SuggestionButton,
  SuggestionNote,
  SuggestionPopoverContent,
  SuggestionReason,
} from '@/components/ui/suggestion-panel'
import { useServerProposal, type ProposalOfKind } from '@/features/grid-cards/hooks/use-server-proposal'
import { useTranslations } from '@/i18n'
import type { FilingFolderSuggestion, FilingSuggestionView } from '../lib/filing-suggestions'

/** The last segment of a folder path: what fits on a chip. */
export function folderLeaf(path: string): string {
  const segments = path.split('/').filter((segment) => segment.trim() !== '')
  return segments.at(-1) ?? path
}

// ─── The suggestions of a shelf ─────────────────────────────────────────────

interface FilingSuggestionsContextValue {
  suggestionFor: (documentId: string) => FilingSuggestionView | undefined
  /** The same suggestions one per target folder, for a filing bar. */
  byFolder: readonly FilingFolderSuggestion[]
  /** A suggestion was decided: re-read the listing and the suggestions. */
  onSettled: () => void
  /** Where a document is now: its folder's path, '' at the top level, undefined when not known. */
  folderPathOf: (documentId: string) => string | undefined
  /** The document whose popover is open on arrival, without taking focus: a preview of the open state. */
  openOnArrival: string | null
}

const FilingSuggestionsContext = createContext<FilingSuggestionsContextValue | null>(null)

/** The suggestions a provider holds, or null outside one. */
export function useFilingSuggestionsContext(): FilingSuggestionsContextValue | null {
  return useContext(FilingSuggestionsContext)
}

// ─── The highlight: which documents a decision in view would move ───────────

/**
 * Which documents are lit right now. A store and not state, so lighting two
 * cards re-renders those two and leaves the other thousand alone
 * (`useSyncExternalStore` compares each card's own answer).
 */
export interface FilingHighlightStore {
  /** Light these documents; the returned function puts them out, unless something else has lit others since. */
  light: (documentIds: readonly string[]) => () => void
  has: (documentId: string) => boolean
  subscribe: (listener: () => void) => () => void
}

function createHighlightStore(): FilingHighlightStore {
  let lit: ReadonlySet<string> = new Set()
  const listeners = new Set<() => void>()
  const set = (next: ReadonlySet<string>) => {
    lit = next
    for (const listener of listeners) listener()
  }
  return {
    light: (documentIds) => {
      const mine = new Set(documentIds)
      set(mine)
      return () => {
        if (lit === mine) set(new Set())
      }
    },
    has: (documentId) => lit.has(documentId),
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}

const FilingHighlightContext = createContext<FilingHighlightStore | null>(null)

/** The highlight of the provider around, for a control that lights documents; null outside one. */
export function useFilingHighlight(): FilingHighlightStore | null {
  return useContext(FilingHighlightContext)
}

const noSubscription = () => () => undefined

/** Whether this document is lit: a filing bar line is hovered or focused, or a chip's popover that moves it is open. */
export function useFilingHighlighted(documentId: string | null | undefined): boolean {
  const store = useContext(FilingHighlightContext)
  return useSyncExternalStore(
    store?.subscribe ?? noSubscription,
    () => Boolean(store && documentId && store.has(documentId)),
    () => false
  )
}

/**
 * Light `documentIds` while `active`; put them out when it ends. A no-op
 * outside a provider (the setup page has no cards to light).
 */
export function useLightWhile(active: boolean, documentIds: readonly string[]): void {
  const store = useFilingHighlight()
  const key = documentIds.join('\u0000')
  useEffect(() => {
    if (!active || !store || key === '') return
    return store.light(key.split('\u0000'))
  }, [active, store, key])
}

const NO_FOLDERS: readonly FilingFolderSuggestion[] = []
const unknownLocation = () => undefined

export function FilingSuggestionsProvider({
  byDocument,
  byFolder = NO_FOLDERS,
  onSettled,
  folderPathOf = unknownLocation,
  openOnArrival = null,
  children,
}: {
  byDocument: ReadonlyMap<string, FilingSuggestionView>
  byFolder?: readonly FilingFolderSuggestion[]
  onSettled: () => void
  folderPathOf?: (documentId: string) => string | undefined
  /** Open this document's popover on first render, without taking focus (`/dev/filing-suggestions`). */
  openOnArrival?: string | null
  children: ReactNode
}): JSX.Element {
  const value = useMemo(
    () => ({
      suggestionFor: (documentId: string) => byDocument.get(documentId),
      byFolder,
      onSettled,
      folderPathOf,
      openOnArrival,
    }),
    [byDocument, byFolder, onSettled, folderPathOf, openOnArrival]
  )
  const [highlight] = useState(createHighlightStore)
  return (
    <FilingSuggestionsContext.Provider value={value}>
      <FilingHighlightContext.Provider value={highlight}>{children}</FilingHighlightContext.Provider>
    </FilingSuggestionsContext.Provider>
  )
}

// ─── The decision, shared by the popover and the bar ────────────────────────

/**
 * One filing suggestion as a person decides it, through the proposal: whether
 * this reader may, what the button says, and once decided (here or by a
 * colleague) the sentence that says what happened, until the shelf re-reads
 * it away.
 */
export function useFilingDecision(suggestion: FilingSuggestionView, onSettled: () => void) {
  const t = useTranslations('files')
  const settled = useCallback((_proposal: ProposalOfKind<'file_operation'>) => onSettled(), [onSettled])
  const { proposal, problem, busy, decide } = useServerProposal(suggestion.proposalId, 'file_operation', settled)
  const status = proposal?.status ?? 'proposed'
  const outcome =
    status === 'proposed'
      ? null
      : status === 'applied' || status === 'partially_applied'
        ? t('filing.moved', { folder: suggestion.folder })
        : status === 'failed'
          ? t('filing.failed')
          : t('filing.kept')
  return {
    status,
    outcome,
    /** Why the move failed, item by item, as the server said it. */
    failure: status === 'failed' ? (proposal?.results?.find((result) => !result.ok)?.reason ?? null) : null,
    mayDecide: proposal ? proposal.canDecide : suggestion.canDecide,
    error: problem === 'apply' || problem === 'dismiss' ? t('filing.error') : null,
    busy,
    apply: () => void decide('apply'),
    dismiss: () => void decide('dismiss'),
  }
}

// ─── The chip and its popover ───────────────────────────────────────────────

/** The suggestion for one document, where a provider holds one: its chip; nothing otherwise. */
export function FilingSuggestionSlot({
  documentId,
  className,
}: {
  documentId: string | null | undefined
  className?: string
}): JSX.Element | null {
  const context = useContext(FilingSuggestionsContext)
  const suggestion = documentId ? context?.suggestionFor(documentId) : undefined
  if (!context || !suggestion || !documentId) return null
  return (
    <FilingSuggestionChip
      key={suggestion.proposalId}
      documentId={documentId}
      suggestion={suggestion}
      onSettled={context.onSettled}
      folderPath={context.folderPathOf(documentId)}
      defaultOpen={context.openOnArrival === documentId}
      className={className}
    />
  )
}

const stop = (event: { stopPropagation: () => void }) => event.stopPropagation()

function FilingSuggestionChip({
  documentId,
  suggestion,
  onSettled,
  folderPath,
  defaultOpen,
  className,
}: {
  documentId: string
  suggestion: FilingSuggestionView
  onSettled: () => void
  folderPath: string | undefined
  defaultOpen: boolean
  className?: string
}): JSX.Element {
  const t = useTranslations('files')
  const [open, setOpen] = useState(defaultOpen)
  const others = useMemo(
    () => suggestion.documentIds.filter((id) => id !== documentId),
    [suggestion.documentIds, documentId]
  )
  useLightWhile(open, others)

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        {/* The chip sits on a card or a row that opens the file: its own
            press, key and click stay its own. */}
        <FilingChip
          target={folderLeaf(suggestion.folder)}
          newLabel={suggestion.isNew ? t('filing.new') : undefined}
          aria-label={t('filing.chip', { folder: suggestion.folder })}
          className={className}
          data-testid="filing-chip"
          onClick={stop}
          onPointerDown={stop}
          onKeyDown={stop}
        />
      </PopoverTrigger>
      <SuggestionPopoverContent
        side="top"
        aria-label={t('filing.label')}
        data-testid="filing-popover"
        // Escape and an outside click close it and focus goes back to the chip
        // (Radix). Opened by default it leaves focus where it is.
        onOpenAutoFocus={defaultOpen ? (event) => event.preventDefault() : undefined}
      >
        <FilingDecisionBody suggestion={suggestion} onSettled={onSettled} folderPath={folderPath} />
      </SuggestionPopoverContent>
    </Popover>
  )
}

/** What the popover holds, mounted only while it is open. */
function FilingDecisionBody({
  suggestion,
  onSettled,
  folderPath,
}: {
  suggestion: FilingSuggestionView
  onSettled: () => void
  folderPath: string | undefined
}): JSX.Element {
  const t = useTranslations('files')
  const decision = useFilingDecision(suggestion, onSettled)
  const others = suggestion.fileCount - 1
  const from =
    folderPath === undefined
      ? undefined
      : folderPath !== ''
        ? folderPath
        : suggestion.shelf === 'office'
          ? t('filing.rootOffice')
          : t('filing.rootProject')

  const path = (
    <PathChange
      from={from}
      to={suggestion.folder}
      toMark={suggestion.isNew ? <NewMark>{t('filing.new')}</NewMark> : undefined}
      fromLabel={t('filing.from')}
      toLabel={t('filing.to')}
    />
  )

  if (decision.outcome) {
    return (
      <>
        {path}
        <SuggestionNote tone="default" data-testid="filing-outcome" data-status={decision.status}>
          {decision.outcome}
        </SuggestionNote>
        {decision.failure && <SuggestionNote tone="error">{decision.failure}</SuggestionNote>}
      </>
    )
  }

  const moveLabel = suggestion.isNew
    ? t('filing.createAndMove')
    : others > 0
      ? t('filing.moveAll', { count: suggestion.fileCount })
      : t('filing.move')

  return (
    <>
      {path}
      {others > 0 && <SuggestionNote data-testid="filing-others">{t('filing.others', { count: others })}</SuggestionNote>}
      {suggestion.reason && <SuggestionReason title={suggestion.reason}>{suggestion.reason}</SuggestionReason>}
      {decision.error && <SuggestionNote tone="error">{decision.error}</SuggestionNote>}
      {decision.mayDecide ? (
        <SuggestionActions>
          <SuggestionButton
            variant="ghost"
            loading={decision.busy?.action === 'dismiss'}
            aria-disabled={decision.busy !== null}
            onClick={decision.dismiss}
            data-testid="filing-suggestion-dismiss"
          >
            {t('filing.keep')}
          </SuggestionButton>
          <SuggestionButton
            loading={decision.busy?.action === 'apply'}
            aria-disabled={decision.busy !== null}
            onClick={decision.apply}
            data-testid="filing-suggestion-apply"
          >
            {moveLabel}
          </SuggestionButton>
        </SuggestionActions>
      ) : (
        <SuggestionNote>{t('filing.readOnly')}</SuggestionNote>
      )}
    </>
  )
}
