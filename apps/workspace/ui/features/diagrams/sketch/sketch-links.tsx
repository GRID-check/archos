'use client'

/**
 * A Skizze's links over its live canvas (S5, `lib/diagrams/sketch-links.ts`).
 *
 * Each element whose `customData` holds a link gets a small mark at its top
 * right corner, placed from where the element stands now (the canvas's scroll
 * and zoom, as `sketch-pins.tsx` places a mark). Pressed, it opens the target
 * in the app (`sketch-link-href.ts`, `router.push`, never a new window); a
 * target that is gone or not this reader's says so quietly, in place, and
 * opens nothing. A linked Anmerkung colours its mark by its status, read live
 * when the Skizze was opened and never stored in the scene.
 *
 * „Verknüpfen“ on one selected element opens the picker (`sketch-link-picker.tsx`);
 * what it picks is written into the element by the canvas (`onLink`), so it
 * travels through the room and is saved like any other change.
 *
 * Only the Excalidraw API's shape is named here, never its module:
 * `sketch-canvas.tsx` stays the one importer (`sketch-isolation.spec.ts`).
 */

import { Link2 } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { capturePosthog } from '@/lib/analytics/posthog'
import { keptSketchLink, sketchLinkKind, type ResolvedSketchLink, type SketchLink } from '@/lib/diagrams/sketch-links'
import { sketchLinkHref } from '@/features/documents'
import { Button } from '@/components/ui/button'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { useTranslations } from '@/i18n'
import { diagramsCopy } from '@/i18n/namespaces/diagrams'
import { cn } from '@/lib/utils'
import { SketchLinkPicker, type PickedSketchLink } from './sketch-link-picker'
import { useCanvasView, type SketchViewApi } from './sketch-pins'

export interface SketchLinksProps {
  api: SketchViewApi | null
  /** The links as the server read them for this reader when the Skizze opened. */
  links: readonly ResolvedSketchLink[]
  /** The project the picker searches; null in the Büroablage, where nothing is linked from the editor. */
  projectId: string | null
  /** Whether the reader may change the element's link: they may write, and the canvas is theirs. */
  canLink: boolean
  /** Write this link (or none) into the element. */
  onLink: (elementId: string, link: SketchLink | null) => void
}

const NOTICE_MS = 2500

/** The same link, whatever order its keys came in. */
const sameRef = (a: SketchLink, b: SketchLink) => JSON.stringify(keptSketchLink(a)) === JSON.stringify(keptSketchLink(b))

/** A linked Anmerkung's status as its mark's colour; the review's tokens. */
function toneOf(link: ResolvedSketchLink | null): string {
  if (!link || link.state !== 'available') return 'bg-muted text-muted-foreground'
  if (link.kind !== 'annotation') return 'bg-primary text-primary-foreground'
  if (link.status === 'resolved') return 'bg-status-done text-primary-foreground'
  if (link.status === 'dismissed') return 'bg-muted text-muted-foreground'
  if (link.annotationKind === 'defect') return 'bg-signal-error text-primary-foreground'
  return 'bg-status-active text-primary-foreground'
}

interface Mark {
  elementId: string
  left: number
  top: number
  link: ResolvedSketchLink | null
}

export function SketchLinks({ api, links, projectId, canLink, onLink }: SketchLinksProps) {
  const t = useTranslations(diagramsCopy)
  const router = useRouter()
  const view = useCanvasView(api)
  // What this tab picked since it opened, read until the next open resolves it on the server.
  const [picked, setPicked] = useState<ResolvedSketchLink[]>([])
  const [notice, setNotice] = useState<string | null>(null)
  const [picking, setPicking] = useState(false)

  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(() => setNotice(null), NOTICE_MS)
    return () => clearTimeout(timer)
  }, [notice])

  const marks = useMemo((): Mark[] => {
    if (!view) return []
    const known = [...picked, ...links]
    return view.elements.flatMap((element) => {
      const ref = keptSketchLink((element as { customData?: unknown }).customData)
      if (!ref || element.isDeleted) return []
      const width = typeof element.width === 'number' ? element.width : 0
      const height = typeof element.height === 'number' ? element.height : 0
      const right = Math.max(element.x, element.x + width)
      const top = Math.min(element.y, element.y + height)
      const link = known.find((entry) => entry.elementId === element.id && sameRef(entry.ref, ref)) ?? null
      return [{ elementId: element.id, left: (right + view.scrollX) * view.zoom, top: (top + view.scrollY) * view.zoom, link }]
    })
  }, [view, links, picked])

  const open = useCallback(
    (mark: Mark) => {
      const href = mark.link ? sketchLinkHref(mark.link) : null
      if (mark.link) capturePosthog('sketch_link_opened', { kind: mark.link.kind, state: href ? 'available' : 'unavailable' })
      if (href) return router.push(href)
      setNotice(mark.elementId)
    },
    [router]
  )

  const selected = view?.selected ?? []
  const target = selected.length === 1 ? selected[0] : null
  const targetLinked = target ? marks.some((mark) => mark.elementId === target) : false
  const pick = useCallback(
    (choice: PickedSketchLink | null) => {
      setPicking(false)
      if (!target) return
      onLink(target, choice?.link ?? null)
      if (!choice) return
      const reading = { elementId: target, kind: sketchLinkKind(choice.link), ref: choice.link, ...choice.reading } as ResolvedSketchLink
      setPicked((current) => [reading, ...current.filter((entry) => entry.elementId !== target)])
    },
    [target, onLink]
  )

  if (!view) return null
  return (
    <div className="pointer-events-none absolute inset-0 z-10 overflow-hidden" data-testid="sketch-links">
      {marks.map((mark) => {
        const label = !mark.link
          ? t('sketch.link.unresolved')
          : mark.link.state === 'available'
            ? t('sketch.link.open', { title: mark.link.page ? t('sketch.link.openPage', { title: mark.link.title, page: String(mark.link.page) }) : mark.link.title })
            : t('sketch.link.gone')
        return (
          <div key={mark.elementId} className="absolute flex -translate-x-1/2 -translate-y-1/2 items-center gap-1" style={{ left: mark.left, top: mark.top }}>
            <button
              type="button"
              className={cn(
                'pointer-events-auto flex size-6 items-center justify-center rounded-full shadow-sm ring-2 ring-background focus-visible:outline-2',
                toneOf(mark.link)
              )}
              aria-label={label}
              title={label}
              onClick={() => open(mark)}
              data-testid="sketch-link-mark"
              data-state={mark.link?.state ?? 'unresolved'}
            >
              <Link2 className="size-3.5" aria-hidden />
            </button>
            {notice === mark.elementId ? (
              <span className="bg-popover text-muted-foreground rounded-control border px-1.5 py-0.5 text-xs shadow-xs" role="status">
                {mark.link ? t('sketch.link.gone') : t('sketch.link.unresolved')}
              </span>
            ) : null}
          </div>
        )
      })}
      {canLink && projectId && target ? (
        <Popover open={picking} onOpenChange={setPicking}>
          <PopoverAnchor asChild>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              className="pointer-events-auto absolute bottom-28 left-1/2 -translate-x-1/2 gap-1.5 shadow-md"
              onClick={() => setPicking(true)}
              data-testid="sketch-link"
            >
              <Link2 className="size-3.5" aria-hidden />
              {t('sketch.link.action')}
            </Button>
          </PopoverAnchor>
          <PopoverContent side="top" className="pointer-events-auto w-auto">
            <SketchLinkPicker projectId={projectId} linked={targetLinked} onPick={pick} onCancel={() => setPicking(false)} />
          </PopoverContent>
        </Popover>
      ) : null}
    </div>
  )
}
