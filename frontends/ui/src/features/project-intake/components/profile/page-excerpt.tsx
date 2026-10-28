'use client'

import type { JSX } from 'react'
import { useContext, useEffect, useRef, useState } from 'react'
import { Skeleton } from '@/components/ui/skeleton'
import { RegionMarks } from '@/features/knowledge/components/region-marks'
import { PageSheet } from '@/features/knowledge/components/pdf-viewer-atoms'
import { useTranslations } from '@/i18n'
import { intakeProfileStepCopy } from '@/i18n/namespaces/intake-profile-step'
import { cn } from '@/lib/utils'
import { EvidenceProjectContext } from '../evidence-chips'
import { drawExcerpt, type DocumentEvidence, type DrawnExcerpt } from './excerpt-loader'

/** Shown width when the figure has not been laid out (a test, a hidden tab). */
const FALLBACK_WIDTH = 360
/** Drawn a little before it scrolls in, so it is there when it arrives. */
const NEAR_MARGIN = '300px 0px'

type State = { status: 'waiting' } | { status: 'drawn'; drawn: DrawnExcerpt } | { status: 'unavailable' }

/** True once the element has come near the viewport; immediately where nothing can tell (no IntersectionObserver). */
function useNear(ref: React.RefObject<HTMLElement | null>): boolean {
  const [near, setNear] = useState(() => typeof IntersectionObserver === 'undefined')
  useEffect(() => {
    const node = ref.current
    if (near || !node || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setNear(true)
      },
      { rootMargin: NEAR_MARGIN }
    )
    observer.observe(node)
    return () => observer.disconnect()
  }, [ref, near])
  return near
}

/**
 * The excerpt of the page a value was found on: the quoted passage, marked as
 * the viewer marks it, with the page around it, at the width of the column.
 * Nothing is fetched or drawn until it is shown and near the screen, so a
 * Steckbrief of forty values costs nothing until someone looks. When the
 * passage cannot be found in the page's text (a scan), the whole page is shown
 * small and says so; when there is nothing to draw, a line says the chip opens
 * the document instead.
 */
export function PageExcerpt({
  evidence,
  className,
}: {
  evidence: DocumentEvidence & { page: number }
  className?: string
}): JSX.Element {
  const t = useTranslations(intakeProfileStepCopy)
  const projectId = useContext(EvidenceProjectContext) ?? null
  const frameRef = useRef<HTMLElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const near = useNear(frameRef)
  const [state, setState] = useState<State>({ status: 'waiting' })
  const { fileName, page, quote } = evidence

  useEffect(() => {
    const canvas = canvasRef.current
    if (!near || !canvas) return
    const controller = new AbortController()
    setState({ status: 'waiting' })
    void drawExcerpt({
      projectId,
      evidence: { kind: 'document', fileName, page, quote },
      canvas,
      cssWidth: frameRef.current?.clientWidth || FALLBACK_WIDTH,
      signal: controller.signal,
    }).then((drawn) => {
      if (!controller.signal.aborted) setState(drawn ? { status: 'drawn', drawn } : { status: 'unavailable' })
    })
    return () => controller.abort()
  }, [near, projectId, fileName, page, quote])

  const label = t('excerpt.figure', { name: fileName, page })
  const drawn = state.status === 'drawn' ? state.drawn : null
  const { mark, crop } = drawn ?? { mark: null, crop: null }

  return (
    <figure
      ref={frameRef}
      className={cn('w-full max-w-md space-y-1.5', className)}
      data-testid="page-excerpt"
      data-state={state.status}
    >
      {state.status === 'unavailable' ? (
        <figcaption className="text-muted-foreground text-xs">{t('excerpt.unavailable')}</figcaption>
      ) : (
        <>
          <PageSheet
            className="w-full overflow-hidden rounded-sm"
            style={{ aspectRatio: crop ? `${crop.width} / ${crop.height}` : '3 / 1' }}
          >
            <canvas
              ref={canvasRef}
              role="img"
              aria-label={label}
              className={cn('block h-full w-full', !drawn && 'invisible')}
            />
            {!drawn && (
              <Skeleton role="status" className="absolute inset-0 rounded-none" aria-label={t('excerpt.loading')} />
            )}
            {mark && crop && (
              <RegionMarks
                regions={[
                  {
                    box: [
                      mark.x / crop.width,
                      mark.y / crop.height,
                      (mark.x + mark.width) / crop.width,
                      (mark.y + mark.height) / crop.height,
                    ],
                  },
                ]}
              />
            )}
          </PageSheet>
          {drawn && !mark && <figcaption className="text-muted-foreground text-xs">{t('excerpt.wholePage')}</figcaption>}
        </>
      )}
    </figure>
  )
}
