'use client'

/**
 * The viewer's controls, in the floating pill's material: one at the foot of
 * the stage for moving through the document, one at its head while searching.
 *
 * Every surface that opens a PDF gets these same controls in the same order —
 * pages, the way back to a passage when there is one, zoom, search — so a
 * reader who learned them in the chat peek finds them where they expect in the
 * citation dialog. What a narrow stage cannot hold drops out by CONTAINER
 * width (the peek is narrow on a wide screen), never by viewport. The page
 * arrows never drop: a multi-page document is unreadable without them. On a
 * touch screen the zoom steps go first (two fingers zoom there, and the level
 * button still fits again), and the fit-page toggle stays. The pill is never
 * wider than its stage: a control pushed past the edge of a phone is a control
 * nobody can reach.
 */

import { useEffect, useRef, useState, type FC, type ReactNode } from 'react'
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Crosshair,
  Minus,
  PanelLeft,
  Plus,
  RectangleVertical,
  Search,
  X,
} from 'lucide-react'
import {
  FloatingToolbar,
  ToolbarDivider,
  ToolbarField,
  ToolbarIconButton,
  ToolbarText,
  ToolbarTextButton,
} from '@/components/ui/floating-toolbar'
import { Spinner } from '@/components/ui/spinner'
import { useTranslations } from '@/i18n'
import { cn } from '@/lib/utils'
import { isFitted, MIN_ZOOM, type FitMode } from '../lib/pdf-zoom'

export interface PdfControlsProps {
  /** Null while the document is still loading. */
  pageCount: number | null
  currentPage: number
  onPage: (page: number) => void
  /** Present when there is a cited passage or region to go back to. */
  onRevealPassage?: () => void
  zoom: number
  /** This document's ceiling (`maxZoomFor`). */
  maxZoom: number
  fit: FitMode
  onZoomStep: (direction: 1 | -1) => void
  onResetZoom: () => void
  onToggleFit: () => void
  searchOpen: boolean
  onToggleSearch: () => void
  /** Whether the page rail is open. */
  railOpen: boolean
  /** Whether the document has a rail at all: one page has none, and its toggle would switch nothing. */
  hasRail?: boolean
  onToggleRail: () => void
  /** The caller's own controls, first in the pill (a review surface's tools). */
  lead?: ReactNode
}

export const PdfControls: FC<PdfControlsProps> = ({
  pageCount,
  currentPage,
  onPage,
  onRevealPassage,
  zoom,
  maxZoom,
  fit,
  onZoomStep,
  onResetZoom,
  onToggleFit,
  searchOpen,
  onToggleSearch,
  railOpen,
  onToggleRail,
  hasRail = true,
  lead,
}) => {
  const t = useTranslations('knowledge')
  const ready = pageCount !== null
  const percent = Math.round(zoom * 100)
  return (
    <FloatingToolbar
      aria-label={t('viewer.controls')}
      data-testid="pdf-floating-toolbar"
      className="scrollbar-hide pointer-events-auto max-w-full overflow-x-auto"
    >
      {lead && (
        <>
          {lead}
          <ToolbarDivider />
        </>
      )}
      {/* The rail is a wide-stage affordance: below the width the rail needs,
          the toggle would switch nothing on. */}
      <ToolbarIconButton
        className={cn('@max-3xl:hidden phone:hidden', !hasRail && 'hidden')}
        aria-pressed={railOpen}
        aria-label={t(railOpen ? 'viewer.hidePages' : 'viewer.showPages')}
        title={t(railOpen ? 'viewer.hidePages' : 'viewer.showPages')}
        onClick={onToggleRail}
        disabled={!ready}
      >
        <PanelLeft aria-hidden />
      </ToolbarIconButton>
      <ToolbarDivider className={cn('@max-3xl:hidden phone:hidden', !hasRail && 'hidden')} />

      {/* Page turning is the one thing every multi-page document needs, so it
          never drops out of the pill; a phone sheds the zoom steps instead
          (pinch does that). */}
      <ToolbarIconButton
        aria-label={t('viewer.previousPage')}
        title={t('viewer.previousPage')}
        disabled={!ready || currentPage <= 1}
        onClick={() => onPage(currentPage - 1)}
      >
        <ChevronLeft aria-hidden />
      </ToolbarIconButton>
      {ready ? (
        <PageField current={currentPage} count={pageCount} onPage={onPage} />
      ) : (
        <ToolbarText>{t('viewer.loading')}</ToolbarText>
      )}
      <ToolbarIconButton
        aria-label={t('viewer.nextPage')}
        title={t('viewer.nextPage')}
        disabled={!ready || currentPage >= (pageCount ?? 1)}
        onClick={() => onPage(currentPage + 1)}
      >
        <ChevronRight aria-hidden />
      </ToolbarIconButton>

      {onRevealPassage && (
        <>
          <ToolbarDivider />
          <ToolbarIconButton
            aria-label={t('viewer.toPassage')}
            title={t('viewer.toPassage')}
            onClick={onRevealPassage}
          >
            <Crosshair aria-hidden />
          </ToolbarIconButton>
        </>
      )}

      <ToolbarDivider />
      <ToolbarIconButton
        className="pointer-coarse:@max-md:hidden"
        aria-label={t('viewer.zoomOut')}
        title={t('viewer.zoomOut')}
        aria-keyshortcuts="-"
        disabled={!ready || zoom <= MIN_ZOOM + 1e-6}
        onClick={() => onZoomStep(-1)}
      >
        <Minus aria-hidden />
      </ToolbarIconButton>
      {/* The level, and the way back to the fit: pressing it fits again. */}
      <ToolbarTextButton
        onClick={onResetZoom}
        disabled={!ready}
        aria-label={
          isFitted(zoom)
            ? t('viewer.zoomFitted', { percent })
            : t('viewer.zoomReset', { percent })
        }
        aria-keyshortcuts="Control+0 Meta+0"
        className="w-11"
      >
        {percent}%
      </ToolbarTextButton>
      <ToolbarIconButton
        className="pointer-coarse:@max-md:hidden"
        aria-label={t('viewer.zoomIn')}
        title={t('viewer.zoomIn')}
        aria-keyshortcuts="+"
        disabled={!ready || zoom >= maxZoom - 1e-6}
        onClick={() => onZoomStep(1)}
      >
        <Plus aria-hidden />
      </ToolbarIconButton>
      <ToolbarIconButton
        className="@max-xs:hidden"
        aria-pressed={fit === 'page'}
        aria-label={t('viewer.fitPage')}
        title={t('viewer.fitPage')}
        disabled={!ready}
        onClick={onToggleFit}
      >
        <RectangleVertical aria-hidden />
      </ToolbarIconButton>

      <ToolbarDivider />
      <ToolbarIconButton
        aria-pressed={searchOpen}
        aria-label={t('viewer.search')}
        title={t('viewer.search')}
        aria-keyshortcuts="Control+F Meta+F"
        disabled={!ready}
        onClick={onToggleSearch}
      >
        <Search aria-hidden />
      </ToolbarIconButton>
    </FloatingToolbar>
  )
}

/**
 * The page field: the current page, editable. Typing a number and pressing
 * Enter (or leaving the field) goes there; anything else snaps back. A page
 * turned from elsewhere — a scroll, a key, the rail — resets it.
 */
const PageField: FC<{ current: number; count: number; onPage: (page: number) => void }> = ({
  current,
  count,
  onPage,
}) => {
  const t = useTranslations('knowledge')
  const [draft, setDraft] = useState(String(current))
  const [shown, setShown] = useState(current)
  if (shown !== current) {
    setShown(current)
    setDraft(String(current))
  }
  const commit = (): void => {
    const next = Number.parseInt(draft, 10)
    if (Number.isFinite(next) && next !== current) onPage(next)
    else setDraft(String(current))
  }
  return (
    <label className="flex items-center gap-1 pl-1">
      <span className="sr-only">{t('viewer.pageInput', { count })}</span>
      <ToolbarField
        type="text"
        inputMode="numeric"
        enterKeyHint="go"
        autoComplete="off"
        data-testid="pdf-page-input"
        value={draft}
        onChange={(event) => setDraft(event.target.value.replace(/\D/g, ''))}
        onBlur={commit}
        onFocus={(event) => event.currentTarget.select()}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            commit()
          }
          if (event.key === 'Escape') setDraft(String(current))
        }}
        className="w-9 px-1 text-center"
      />
      <ToolbarText aria-hidden className="pl-0">
        {t('viewer.pageOfTotal', { count })}
      </ToolbarText>
    </label>
  )
}

export interface PdfSearchBarProps {
  query: string
  onQuery: (query: string) => void
  /** Null while the document is still being searched. */
  count: number | null
  /** 0-based index of the hit on screen. */
  active: number
  onStep: (direction: 1 | -1) => void
  onClose: () => void
  /** A short query does not search; it says nothing rather than "no matches". */
  tooShort: boolean
}

/**
 * Find in document: a field, the count, and next / previous. Enter goes to the
 * next hit, Shift+Enter to the previous, Escape closes and hands the keyboard
 * back to the document. The count is a live region, so a screen-reader user
 * hears "3 of 12" as they type, as everyone else sees it.
 */
export const PdfSearchBar: FC<PdfSearchBarProps> = ({
  query,
  onQuery,
  count,
  active,
  onStep,
  onClose,
  tooShort,
}) => {
  const t = useTranslations('knowledge')
  const inputRef = useRef<HTMLInputElement | null>(null)
  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])
  const status = tooShort
    ? ''
    : count === null
      ? t('viewer.searching')
      : count === 0
        ? t('viewer.searchNone')
        : t('viewer.searchCount', { index: active + 1, count })
  return (
    <FloatingToolbar
      role="search"
      aria-label={t('viewer.search')}
      data-testid="pdf-search-bar"
      className="pointer-events-auto max-w-full"
    >
      <Search aria-hidden className="text-muted-foreground mx-1.5 size-3.5 shrink-0" />
      <ToolbarField
        ref={inputRef}
        type="search"
        enterKeyHint="search"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        aria-label={t('viewer.searchField')}
        placeholder={t('viewer.searchPlaceholder')}
        value={query}
        onChange={(event) => onQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            onStep(event.shiftKey ? -1 : 1)
          }
          if (event.key === 'Escape') {
            event.preventDefault()
            event.stopPropagation()
            onClose()
          }
        }}
        className="w-36 min-w-0 shrink @md:w-48"
      />
      <ToolbarText
        role="status"
        aria-live="polite"
        data-testid="pdf-search-count"
        className={cn('min-w-12 text-center', count === null && 'inline-flex items-center gap-1')}
      >
        {count === null && !tooShort && <Spinner size="xs" aria-hidden />}
        {status}
      </ToolbarText>
      <ToolbarIconButton
        aria-label={t('viewer.searchPrevious')}
        title={t('viewer.searchPrevious')}
        disabled={!count}
        onClick={() => onStep(-1)}
      >
        <ChevronUp aria-hidden />
      </ToolbarIconButton>
      <ToolbarIconButton
        aria-label={t('viewer.searchNext')}
        title={t('viewer.searchNext')}
        disabled={!count}
        onClick={() => onStep(1)}
      >
        <ChevronDown aria-hidden />
      </ToolbarIconButton>
      <ToolbarIconButton aria-label={t('viewer.searchClose')} title={t('viewer.searchClose')} onClick={onClose}>
        <X aria-hidden />
      </ToolbarIconButton>
    </FloatingToolbar>
  )
}
