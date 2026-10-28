'use client'

import type { JSX } from 'react'
import { useState } from 'react'
import { Check, Video } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslations } from '@/i18n'
import { bimCopy } from '@/i18n/namespaces/bim'
import { cn } from '@/lib/utils'
import { BIM_CAMERA_VIEWS, type BimCameraView } from '../lib/viewer-camera'
import { ViewerIconButtonBase, ViewerToolButton } from './viewer'

/**
 * Which way the building is facing.
 *
 * A menu rather than six buttons in the bar. The old toolbar spent six of its
 * nine slots on view names, which put the two controls anyone uses — the cut
 * and the see-through — at the end of a row of words. Folding the directions
 * into one control is what made room for the bar to be readable.
 *
 * The projection toggle lives in here too, at the bottom, because it only ever
 * matters in the sentence "…and draw it parallel so it measures" — which is a
 * thought you have while choosing a view, not on its own.
 */
export function StageViewMenu({
  view,
  orthographic,
  onViewChange,
  onOrthographicChange,
  disabled,
  trigger = 'icon',
  side = 'top',
}: {
  view: BimCameraView
  orthographic: boolean
  onViewChange: (view: BimCameraView) => void
  onOrthographicChange: (orthographic: boolean) => void
  disabled: boolean
  /**
   * `icon` is the desktop dock's glyph; `tool` is the phone's glyph over a
   * caption. Same menu, same state — a finger gets the name written on the
   * control, because it has no tooltip to ask.
   */
  trigger?: 'icon' | 'tool'
  /** Which edge of the trigger the menu opens from: above a bar, beside a column. */
  side?: 'top' | 'right'
}): JSX.Element {
  const t = useTranslations(bimCopy)
  /**
   * Controlled so choosing a view CLOSES the menu.
   *
   * It did not, so picking "Grundriss" left an 11 rem popover sitting over the
   * lower-left of the building the reader had just re-oriented to look at —
   * and the one thing they wanted to see was behind it.
   */
  const [open, setOpen] = useState(false)

  return (
    <Popover open={open} onOpenChange={setOpen}>
      {/*
        The trigger is the BUTTON, not a wrapper around it. A `<span>` in
        between takes Radix's props — including the ones that make Enter open
        the menu — and leaves the focused button inert, which is a control that
        works with a mouse and not with a keyboard.
      */}
      {trigger === 'tool' ? (
        <PopoverTrigger asChild>
          <ViewerToolButton
            label={
              view === 'iso' ? t('stage.views') : `${t('stage.views')}: ${t(`viewer.view.${view}`)}`
            }
            // The active view takes the caption's place: "Grundriss" says more
            // than "Ansicht" does once one has been chosen, and it is the only
            // way a finger can learn the state without opening the menu.
            caption={view === 'iso' ? t('stage.views') : t(`viewer.view.${view}`)}
            icon={Video}
            disabled={disabled}
            active={view !== 'iso'}
          />
        </PopoverTrigger>
      ) : (
        <Tooltip>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>
              {/*
                The name of the active view, on the trigger. Section, Measure and
                See-through all light up when they are on; this one looked
                identical whether the reader was on the north elevation in
                parallel projection or in the free perspective default, so the
                only way to find out was to open the menu and read it. The
                `adornment` prop exists for exactly this and had no caller.
              */}
              <ViewerIconButtonBase
                label={t('stage.views')}
                icon={Video}
                disabled={disabled}
                active={view !== 'iso'}
                adornment={
                  view === 'iso' ? undefined : (
                    <span className="text-xs font-medium">{t(`viewer.view.${view}`)}</span>
                  )
                }
              />
            </PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={8}>
            {t('stage.views')}
          </TooltipContent>
        </Tooltip>
      )}
      <PopoverContent
        side={side}
        sideOffset={10}
        align={side === 'top' ? 'start' : 'center'}
        className="w-44 p-1.5"
      >
        <div className="grid gap-0.5" role="group" aria-label={t('stage.views')}>
          {BIM_CAMERA_VIEWS.map((candidate) => (
            <button
              key={candidate}
              type="button"
              aria-pressed={view === candidate}
              onClick={() => {
                onViewChange(candidate)
                setOpen(false)
              }}
              className={cn(
                // `pointer-coarse:min-h-11`: these are raw buttons, so they
                // never see the floor `Button` applies. ~30 px rows two pixels
                // apart are the only route to a plan or an elevation.
                'focus-visible:ring-ring/60 pointer-coarse:min-h-11 duration-quick flex items-center justify-between rounded-lg px-2 py-1.5 text-left text-sm font-medium outline-none transition-colors ease-out focus-visible:ring-2',
                view === candidate
                  ? 'bg-accent text-foreground'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground'
              )}
            >
              {t(`viewer.view.${candidate}`)}
              {view === candidate && <Check className="size-3.5" aria-hidden="true" />}
            </button>
          ))}
        </div>
        <div className="border-border mt-1.5 border-t pt-1.5">
          <button
            type="button"
            aria-pressed={orthographic}
            onClick={() => onOrthographicChange(!orthographic)}
            className="focus-visible:ring-ring/60 text-muted-foreground hover:bg-muted hover:text-foreground pointer-coarse:min-h-11 duration-quick flex w-full items-center justify-between rounded-lg px-2 py-1.5 text-left text-sm font-medium outline-none transition-colors ease-out focus-visible:ring-2"
          >
            {t('viewer.projection.parallel')}
            {orthographic && <Check className="size-3.5" aria-hidden="true" />}
          </button>
        </div>
      </PopoverContent>
    </Popover>
  )
}
