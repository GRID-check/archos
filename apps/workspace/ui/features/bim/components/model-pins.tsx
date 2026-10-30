'use client'

import type { JSX } from 'react'
import { CommentPin, COMMENT_PIN_ON_POINT } from '@/components/ui/comment-pin'
import { markInk } from '@/features/documents'
import { useTranslations } from '@/i18n'
import { bimCopy } from '@/i18n/namespaces/bim'
import { isLive, type AnnotationView } from '@/lib/annotations/types'
import type { ViewerPin } from '../lib/viewpoint-bridge'

/**
 * The marks' pins over the model: the review's own `CommentPin` (number, colour,
 * state) with its corner on the pin's point. Each sits in a zero-size wrapper
 * that the canvas moves every frame (`lib/viewpoint-pins.ts`); hidden until its
 * first placement, so a pin never flashes at the corner.
 */
export function ModelPins({
  marks,
  pins,
  selectedId,
  onOpen,
}: {
  marks: readonly AnnotationView[]
  pins: readonly ViewerPin[]
  selectedId: string | null
  onOpen: (annotationId: string) => void
}): JSX.Element {
  const t = useTranslations(bimCopy)
  const drawn = new Set(pins.map((pin) => pin.id))
  return (
    <>
      {marks
        .filter((mark) => drawn.has(mark.id))
        .map((mark) => (
          <div
            key={mark.id}
            data-pin-id={mark.id}
            className="absolute top-0 left-0 size-0"
            style={{ visibility: 'hidden' }}
          >
            <CommentPin
              number={mark.number}
              color={markInk(mark)}
              proposed={mark.status === 'proposed'}
              done={!isLive(mark)}
              active={mark.id === selectedId}
              className={`${COMMENT_PIN_ON_POINT} pointer-events-auto`}
              aria-label={t('marks.pin', { number: mark.number })}
              data-testid="model-pin"
              onClick={() => onOpen(mark.id)}
            />
          </div>
        ))}
    </>
  )
}
