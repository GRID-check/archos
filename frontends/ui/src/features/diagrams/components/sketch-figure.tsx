'use client'

/**
 * An ```` ```excalidraw ```` fence in an answer, drawn: a sketch Piloti wrote in
 * Excalidraw's own element format (ADR-0146).
 *
 * ## The states
 *
 *   - **streaming** — the fence is still arriving. Every element that has
 *     arrived whole is drawn as it lands (`streamedSketchElements`), the way
 *     Excalidraw's own MCP app draws while the model writes; before the first
 *     one, the drawing's placeholder.
 *   - **refused** — the server refused the fence (it arrives tagged
 *     `excalidraw-refused`) or the browser's check does (an answer stored
 *     before the server checked). The source, as a code block, and one quiet
 *     line. Never a red box: a sketch that did not work costs the reader
 *     nothing they did not already have.
 *   - **drawn** — the sketch on a sheet, the line that says it is not to scale,
 *     and inside a project „Im Projekt ablegen" and „Als Skizze bearbeiten".
 *
 * ## Why the drawn SVG is injected as markup
 *
 * `renderSketch` returns a string Excalidraw exported and the server's own SVG
 * validator re-serialised from its allow-list (`sketch-svg.ts`), the same
 * provenance `mermaid-diagram.tsx` argues for its markup. The skeletons it drew
 * passed `lib/diagrams/sketch-fence.ts` first: no image, no embed, no link.
 *
 * ## The sheet
 *
 * A sketch is drawn and filed on white, as the editor draws it. In dark mode
 * the sheet takes Excalidraw's own dark theme, a filter over the same picture
 * (`invert(93%) hue-rotate(180deg)`, what its canvas does), so the inline
 * sketch, the editor in dark mode and the filed copy are one drawing.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence } from 'motion/react'
import { CodeBlock } from '@/shared/components/CodeBlock'
import { useTranslations } from '@/i18n'
import {
  readSketchFence,
  streamedSketchElements,
  type SceneSkeleton,
} from '@/lib/diagrams/sketch-fence'
import { viewBoxWidth } from '../diagram-size'
import { useDiagramFiling } from '../use-diagram-filing'
import type { RenderedSketch } from '../sketch/sketch-render'
import { SketchDialog } from '../sketch/sketch-dialog'
import { CAPTION_CONTROL, DiagramFilingControls } from './diagram-filing-controls'
import { DrawingCaption, DrawingReveal, DrawingSkeleton } from './drawing-skeleton'

export interface SketchFigureProps {
  /** The fence's body, as written. */
  source: string
  /** True while the fence is still being written. */
  isStreaming?: boolean
  /** The server refused the fence (`excalidraw-refused`). */
  refused?: boolean
}

/**
 * The paper SVG for a list of skeletons, drawn by Excalidraw once its chunk is
 * loaded. One render at a time: while one runs, the newest list waits, and the
 * lists between are skipped, so a fast stream redraws at Excalidraw's pace, not
 * the token rate.
 */
function useRenderedSketch(elements: readonly SceneSkeleton[] | null) {
  const [rendered, setRendered] = useState<RenderedSketch | null>(null)
  const [failed, setFailed] = useState(false)
  const key = useMemo(() => (elements && elements.length ? JSON.stringify(elements) : null), [elements])
  const running = useRef(false)
  const waiting = useRef<readonly SceneSkeleton[] | null>(null)
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  useEffect(() => {
    if (!key || !elements) return
    waiting.current = elements
    if (running.current) return
    running.current = true
    void (async () => {
      try {
        const { renderSketch } = await import('../sketch/sketch-render')
        while (waiting.current && alive.current) {
          const next = waiting.current
          waiting.current = null
          const result = await renderSketch(next)
          if (alive.current) setRendered(result)
        }
      } catch (error) {
        console.debug('[diagrams] sketch render failed', error)
        if (alive.current) setFailed(true)
      } finally {
        running.current = false
      }
    })()
    // `key` names the elements' content; a new array with the same content is no change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  return { rendered, failed }
}

export function SketchFigure({ source, isStreaming = false, refused = false }: SketchFigureProps) {
  const t = useTranslations('diagrams')
  const fence = useMemo(() => (isStreaming || refused ? null : readSketchFence(source)), [source, isStreaming, refused])
  const streamed = useMemo(() => (isStreaming ? streamedSketchElements(source) : null), [source, isStreaming])
  const elements = fence?.ok ? fence.elements : streamed
  const { rendered, failed } = useRenderedSketch(elements)
  const title = fence?.ok ? fence.title : null

  // Filed as drawn: the scene Excalidraw made of the fence, and its paper SVG.
  const renderedRef = useRef(rendered)
  renderedRef.current = rendered
  const filing = useDiagramFiling({
    source,
    fileSvg: null,
    title,
    edited: false,
    prepareSketch: async () => {
      const current = renderedRef.current
      if (!current) throw new Error('the sketch is not drawn yet')
      return { source: current.scene, svg: current.svg }
    },
  })
  const [editing, setEditing] = useState(false)

  if (refused || (fence && !fence.ok) || failed) {
    const lineCount = source.split('\n').length
    return (
      <div data-testid="sketch-figure" data-state="refused" className="my-4 [&>div:first-child]:my-0">
        <CodeBlock value={source} language="json" collapsible={lineCount > 15} maxLines={15} />
        <p className="text-muted-foreground mt-1 text-xs">{t('sketch.fallback')}</p>
      </div>
    )
  }

  const drawn = Boolean(rendered) && !isStreaming
  const label = title ?? t('sketch.defaultTitle')
  return (
    <figure
      className="@container my-4"
      data-testid="sketch-figure"
      data-state={isStreaming ? 'streaming' : drawn ? 'drawn' : 'drawing'}
      aria-busy={drawn ? undefined : true}
      aria-label={label}
    >
      <div className="border-border rounded-xl border bg-white p-2 dark:[filter:invert(93%)_hue-rotate(180deg)] [&_svg]:h-auto [&_svg]:w-full">
        <DrawingReveal drawn={Boolean(rendered)}>
          {rendered ? (
            <div
              // Safe because of what produced the string: Excalidraw drew allow-listed
              // skeletons and `fileableSketchSvg` re-serialised the result through
              // `lib/diagrams/svg.ts` (see the header).
              // nosemgrep: typescript.react.security.audit.react-dangerouslysetinnerhtml.react-dangerouslysetinnerhtml
              // At its own width, or the column's: a sketch is a picture, and one
              // scrolled sideways hides its right half (a comparison board's
              // second column). The editor is where a reader zooms in.
              style={{ width: `${viewBoxWidth(rendered.svg) ?? 720}px`, maxWidth: '100%' }}
              dangerouslySetInnerHTML={{ __html: rendered.svg }}
            />
          ) : (
            <DrawingSkeleton />
          )}
        </DrawingReveal>
      </div>
      <AnimatePresence initial={false}>
        {drawn ? (
          <DrawingCaption
            key="caption"
            className="text-muted-foreground flex flex-wrap items-center gap-x-3 pt-1 text-xs"
          >
            {/* The doctrine, where the reader is: a sketch claims no dimension. */}
            <span>{t('sketch.notToScale')}</span>
            <DiagramFilingControls filing={filing} />
            {filing.target ? (
              <button
                type="button"
                onClick={() => setEditing(true)}
                className={CAPTION_CONTROL}
                data-testid="sketch-edit"
              >
                {t('sketch.action')}
              </button>
            ) : null}
          </DrawingCaption>
        ) : null}
      </AnimatePresence>
      {editing && fence?.ok ? (
        <SketchDialog
          open={editing}
          onOpenChange={setEditing}
          source={source}
          elements={fence.elements}
          title={fence.title}
        />
      ) : null}
    </figure>
  )
}
