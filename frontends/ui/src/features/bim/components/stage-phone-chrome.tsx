'use client'

/**
 * The model stage's chrome on a phone: what goes in the tool bar, and what
 * goes behind "Mehr".
 *
 * ## Why this is not the desktop dock made smaller
 *
 * The desktop dock holds ten controls and was ~480 px wide in a 369 px row, so
 * on a phone the trailing ones sat off-screen behind a hidden scrollbar with
 * nothing to say they existed. Shrinking ten glyphs does not make them
 * findable by a thumb in a glove, and a tooltip is not available to explain
 * them. The phone gets the opposite trade: FEWER, LABELLED controls.
 *
 * Six tools are on the bar because they are what someone on site does to a
 * building, in order of how often: put it back in frame, turn it, cut it,
 * measure it, narrow it to a floor. Everything else — undo, a picture, the
 * see-through, the reset, the analytical drawer — is one tap behind "Mehr",
 * where each can be written out in full.
 *
 * Every control here is a `viewer` atom. This file composes; it styles
 * nothing.
 */

import type { JSX } from 'react'
import {
  Camera,
  Eye,
  Home,
  Layers,
  Layers3,
  MonitorX,
  MoreHorizontal,
  Ruler,
  Scissors,
  SlidersHorizontal,
  Undo2,
} from 'lucide-react'
import { useTranslations } from '@/i18n'
import type { BimCameraView } from '../lib/viewer-camera'
import { StageViewMenu } from './stage-view-menu'
import { ViewerRailItem, ViewerToolButton } from './viewer'

/** Which sheet the bar's two sheet-opening tools control. */
export type PhoneSheet = 'levels' | 'more'

export interface PhoneToolsProps {
  /** `side` is the landscape column; the view menu then opens beside it. */
  placement: 'bar' | 'side'
  /** The renderer can act — every tool except Mehr and Ebenen waits for it. */
  ready: boolean
  onFit: () => void
  cameraView: BimCameraView
  orthographic: boolean
  onViewChange: (view: BimCameraView) => void
  onOrthographicChange: (orthographic: boolean) => void
  sectionOn: boolean
  onToggleSection: () => void
  measuring: boolean
  onToggleMeasure: () => void
  /** Whether there is anything to pick: a second model, or named levels. */
  hasLevels: boolean
  sheet: PhoneSheet | null
  onToggleSheet: (sheet: PhoneSheet) => void
  /** Something has been hidden or isolated — the reset waits behind Mehr. */
  edited: boolean
}

export function PhoneTools({
  placement,
  ready,
  onFit,
  cameraView,
  orthographic,
  onViewChange,
  onOrthographicChange,
  sectionOn,
  onToggleSection,
  measuring,
  onToggleMeasure,
  hasLevels,
  sheet,
  onToggleSheet,
  edited,
}: PhoneToolsProps): JSX.Element {
  const t = useTranslations('bim')
  // A column has the height to spare for none of the bar's 56 px.
  const dense = placement === 'side' ? 'h-12 pointer-coarse:h-12' : undefined

  return (
    <>
      <ViewerToolButton
        label={t('stage.home')}
        caption={t('stage.tool.fit')}
        icon={Home}
        disabled={!ready}
        onClick={onFit}
        className={dense}
      />
      <StageViewMenu
        trigger="tool"
        side={placement === 'side' ? 'right' : 'top'}
        view={cameraView}
        orthographic={orthographic}
        onViewChange={onViewChange}
        onOrthographicChange={onOrthographicChange}
        disabled={!ready}
      />
      <ViewerToolButton
        label={t('viewer.section.toggle')}
        icon={Scissors}
        active={sectionOn}
        disabled={!ready}
        onClick={onToggleSection}
        className={dense}
      />
      <ViewerToolButton
        label={t('viewer.measure.toggle')}
        icon={Ruler}
        active={measuring}
        disabled={!ready}
        onClick={onToggleMeasure}
        className={dense}
      />
      <ViewerToolButton
        label={t('stage.levels')}
        icon={Layers3}
        active={sheet === 'levels'}
        disabled={!hasLevels}
        onClick={() => onToggleSheet('levels')}
        className={dense}
      />
      <ViewerToolButton
        label={t('stage.tool.more')}
        icon={MoreHorizontal}
        active={sheet === 'more'}
        // A dot rather than a count: it says "something here is not as it was"
        // — a hidden wall, an isolated floor — and the reset it points to is
        // inside.
        marked={edited && sheet !== 'more'}
        onClick={() => onToggleSheet('more')}
        className={dense}
      />
    </>
  )
}

export interface PhoneMoreRowsProps {
  ready: boolean
  canUndo: boolean
  onUndo: () => void
  onCapture: () => void
  captureFailed: boolean
  xray: boolean
  /** Why see-through cannot act yet, when it cannot — written out, not hovered. */
  xrayHint: string | null
  xrayDisabled: boolean
  onToggleXray: () => void
  edited: boolean
  onShowEverything: () => void
  advancedDisabled: boolean
  onOpenAdvanced: () => void
}

/** What "Mehr" lists: each tool written out, one 44 px row apiece. */
export function PhoneMoreRows({
  ready,
  canUndo,
  onUndo,
  onCapture,
  captureFailed,
  xray,
  xrayHint,
  xrayDisabled,
  onToggleXray,
  edited,
  onShowEverything,
  advancedDisabled,
  onOpenAdvanced,
}: PhoneMoreRowsProps): JSX.Element {
  const t = useTranslations('bim')
  return (
    <div className="flex flex-col gap-0.5 p-1.5" role="group" aria-label={t('stage.more')}>
      <ViewerRailItem
        label={t('stage.back')}
        toggle={false}
        icon={<Undo2 aria-hidden="true" />}
        disabled={!canUndo}
        onClick={onUndo}
      />
      <ViewerRailItem
        label={captureFailed ? t('viewer.capture.failed') : t('viewer.capture.action')}
        toggle={false}
        icon={captureFailed ? <MonitorX aria-hidden="true" /> : <Camera aria-hidden="true" />}
        disabled={!ready}
        onClick={onCapture}
      />
      <ViewerRailItem
        label={t('viewer.xray')}
        icon={<Eye aria-hidden="true" />}
        selected={xray}
        disabled={!ready || xrayDisabled}
        onClick={onToggleXray}
      />
      {xrayDisabled && xrayHint && (
        <p className="text-muted-foreground px-2 pb-1 text-xs">{xrayHint}</p>
      )}
      {edited && (
        <ViewerRailItem
          label={t('stage.showEverything')}
          toggle={false}
          icon={<Layers aria-hidden="true" />}
          onClick={onShowEverything}
        />
      )}
      <ViewerRailItem
        label={t('stage.advanced')}
        toggle={false}
        icon={<SlidersHorizontal aria-hidden="true" />}
        disabled={advancedDisabled}
        onClick={onOpenAdvanced}
      />
    </div>
  )
}
