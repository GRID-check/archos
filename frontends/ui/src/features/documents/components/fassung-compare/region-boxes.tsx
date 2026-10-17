'use client'

import type { JSX } from 'react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslations } from '@/i18n'
import { cn } from '@/lib/utils'
import { ChangeBadge } from './compare-atoms'
import type { PageSize } from './types'
import { regionToPixels, type NumberedRegion } from './lib/regions'
import type { ActiveRegion } from './use-active-region'

export interface RegionBoxesProps {
  regions: readonly NumberedRegion[]
  /** The page as drawn, in CSS pixels. */
  size: PageSize
  /** The change the whole comparison is looking at; hovering a box previews it, clicking pins it. */
  activeRegion: ActiveRegion
  /** Dashed boxes, for the overlay, where a solid line could be taken for ink. */
  dashed?: boolean
}

/**
 * The changed places on one page: an outlined box and its numbered tag.
 *
 * Each box is a button: hovering or focusing it names the change in a tooltip
 * and lights its row in the list; clicking pins it there. Pixels, not
 * percentages, so the mapping is the one pure function the specs hold
 * (`regionToPixels`). The outline is the mark ink at 2 px with a white halo,
 * over an 8 % wash of the same ink, so a box is findable on a busy drawing
 * without hiding the lines the reader is checking. While one change is active
 * the others step back.
 */
export function RegionBoxes({ regions, size, activeRegion, dashed = false }: RegionBoxesProps): JSX.Element | null {
  const t = useTranslations('files')
  if (regions.length === 0) return null
  const { active, pinned, preview, pin } = activeRegion
  return (
    <>
      {regions.map(({ number, region }) => {
        const box = regionToPixels(region, size)
        const isActive = active === number
        const label = t('compare.changeTag', { number, label: region.label })
        return (
          <Tooltip key={number}>
            <TooltipTrigger asChild>
              <button
                type="button"
                data-testid="compare-region"
                data-region={number}
                data-active={isActive || undefined}
                aria-label={label}
                aria-pressed={pinned === number}
                onPointerEnter={() => preview(number)}
                onPointerLeave={() => preview(null)}
                onFocus={() => preview(number)}
                onBlur={() => preview(null)}
                onClick={() => pin(pinned === number ? null : number)}
                className={cn(
                  'absolute z-[2] cursor-pointer rounded-sm border-2 border-[var(--compare-mark)] bg-[var(--compare-mark-fill)] shadow-[0_0_0_1px_var(--compare-paper)] outline-none',
                  'duration-quick transition-[opacity,background-color] ease-out',
                  'focus-visible:shadow-[0_0_0_1px_var(--compare-paper),0_0_0_3px_var(--compare-paper-ink)]',
                  dashed && 'border-dashed',
                  isActive && 'z-[3] border-[3px] bg-[var(--compare-mark-fill-active)]',
                  active !== null && !isActive && 'opacity-60',
                )}
                style={{ left: box.left, top: box.top, width: box.width, height: box.height }}
              >
                <ChangeBadge
                  number={number}
                  // Above the box, unless the box touches the sheet's top edge.
                  className={cn('absolute -top-0.5 -left-0.5', box.top >= 22 && '-translate-y-full')}
                />
              </button>
            </TooltipTrigger>
            <TooltipContent side="top">{label}</TooltipContent>
          </Tooltip>
        )
      })}
    </>
  )
}
