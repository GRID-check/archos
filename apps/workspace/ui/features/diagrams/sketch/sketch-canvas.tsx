'use client'

/**
 * The Excalidraw canvas, and the only module that imports `@excalidraw/excalidraw`.
 *
 * It is 2.5 MB gzipped (`docs/architecture/diagrams.md`, "Measured cost"), so
 * it is never imported statically: `sketch-dialog.tsx` loads this file with
 * `next/dynamic` and `ssr: false` when a person presses „Als Skizze
 * bearbeiten", and not before. Nothing else may import it; the bundle numbers
 * in ADR-0141 depend on that.
 *
 * ## What is switched off, and why
 *
 * Excalidraw is a whole whiteboard app. Inside Piloti it is a sketch pad for
 * one drawing, so everything that reaches outside the office or outside that
 * drawing is off:
 *
 *   - **Fonts from our own origin** (`excalidraw-assets.ts`), staged into
 *     `public/excalidraw/` the way pdf.js's are.
 *   - **No images, no embeds.** An image would be refused by the SVG
 *     validator, and an embed is a third-party page inside a filed document.
 *   - **No load, save, export or image download of its own.** Filing into the
 *     project is the one way out, so the file lands where the office looks
 *     and carries its provenance. No collaboration (it needs a room server),
 *     no library browser (it opens libraries.excalidraw.com).
 *   - **No AI and no mermaid import.** `aiEnabled={false}` takes the AI tools
 *     out of the menus, and the `ttd` dialog, which the extra-tools menu still
 *     opens for mermaid, is closed the moment it opens (`sketch-guards.ts`).
 *   - **Helvetica for new text** (`SKETCH_FONT_FAMILY`), the type the SVG and
 *     the PDF can show, so what is filed reads like what was drawn.
 */

import { useCallback, useEffect, useMemo, useRef } from 'react'
import './excalidraw-assets'
import {
  convertToExcalidrawElements,
  Excalidraw,
  exportToSvg,
  MainMenu,
  serializeAsJSON,
} from '@excalidraw/excalidraw'
import '@excalidraw/excalidraw/index.css'
import { DIAGRAM_SOURCE_FACTS } from '@/lib/diagrams/diagram-sources'
import { SKETCH_FONT_FAMILY, SKETCH_FONT_SIZE } from './sketch-from-model'
import { fileableSketchSvg } from './sketch-svg'
import { opensForbiddenDialog } from './sketch-guards'

type ExcalidrawApi = Parameters<NonNullable<React.ComponentProps<typeof Excalidraw>['excalidrawAPI']>>[0]

/** What the dialog can ask of the canvas without importing Excalidraw itself. */
export interface SketchCanvasHandle {
  /** The scene as an `.excalidraw` document and its paper SVG, ready to file. */
  prepare: () => Promise<{ source: string; svg: string }>
}

export interface SketchCanvasProps {
  /** Excalidraw skeletons: a model laid out (`sketch-from-model.ts`) or a sketch fence (`bff/diagrams/sketch-fence.ts`). */
  initialElements: readonly object[]
  /**
   * A filed sketch's stored scene (`GET /api/documents/{id}/sketch`), opened as it was saved: its
   * elements are whole Excalidraw elements, not skeletons, so their ids survive the round trip.
   */
  initialScene?: { elements: readonly object[]; appState?: Record<string, unknown> } | null
  theme: 'light' | 'dark'
  langCode: string
  /** Called once the canvas can be asked for its scene. */
  onReady: (handle: SketchCanvasHandle) => void
  /** True once the person changed anything, false again only by reopening. */
  onDirtyChange: (dirty: boolean) => void
  /**
   * Once filed or saved, the canvas only shows. An edit after that would be
   * neither in the project nor guarded by the discard question; the next
   * Fassung starts by opening the filed sketch again from Files.
   */
  readOnly?: boolean
}

/** A scene's version: Excalidraw bumps an element's `version` on every edit. */
function sceneVersion(elements: readonly { version: number; isDeleted?: boolean }[]): number {
  return elements.reduce((sum, element) => sum + element.version + (element.isDeleted ? 1 : 0), 0)
}

/** The source cap the server applies to an Excalidraw scene; refused here first, with the same rule. */
const MAX_SCENE_BYTES = DIAGRAM_SOURCE_FACTS.excalidraw.maxSourceBytes

export class SketchTooLargeError extends Error {
  constructor() {
    super('the sketch is larger than an Excalidraw source may be')
    this.name = 'SketchTooLargeError'
  }
}

export default function SketchCanvas({
  initialElements,
  initialScene = null,
  theme,
  langCode,
  onReady,
  onDirtyChange,
  readOnly = false,
}: SketchCanvasProps) {
  const apiRef = useRef<ExcalidrawApi | null>(null)
  const baseline = useRef<number | null>(null)
  const dirty = useRef(false)

  // The skeletons are bound and measured once, by Excalidraw itself.
  // A stored scene is handed over whole; Excalidraw restores it on load.
  const elements = useMemo(
    () =>
      (initialScene?.elements as ReturnType<typeof convertToExcalidrawElements> | undefined) ??
      convertToExcalidrawElements(initialElements as unknown as Parameters<typeof convertToExcalidrawElements>[0]),
    [initialElements, initialScene]
  )

  const prepare = useCallback(async () => {
    const api = apiRef.current
    if (!api) throw new Error('the canvas is not ready')
    const scene = api.getSceneElements()
    const appState = api.getAppState()
    const files = api.getFiles()
    const source = serializeAsJSON(scene, appState, files, 'local')
    if (new TextEncoder().encode(source).length > MAX_SCENE_BYTES) throw new SketchTooLargeError()
    const svg = await exportToSvg({
      elements: scene,
      // Always paper: a filed document is previewed, printed and attached on white.
      appState: { ...appState, exportBackground: true, viewBackgroundColor: '#ffffff', exportWithDarkMode: false },
      files,
      exportPadding: 16,
      skipInliningFonts: true,
    })
    return { source, svg: fileableSketchSvg(svg) }
  }, [])

  useEffect(() => {
    onReady({ prepare })
  }, [onReady, prepare])

  return (
    // The library sidebar's trigger opens a browser for libraries.excalidraw.com;
    // there is no prop for it in 0.18, so it is hidden here.
    <div className="h-full w-full [&_.default-sidebar-trigger]:hidden!" data-testid="sketch-canvas">
      <Excalidraw
        excalidrawAPI={(api) => {
          apiRef.current = api
        }}
        initialData={{
          elements,
          appState: {
            ...initialScene?.appState,
            viewBackgroundColor: '#ffffff',
            currentItemFontFamily: SKETCH_FONT_FAMILY,
            currentItemFontSize: SKETCH_FONT_SIZE,
            currentItemRoughness: 1,
            currentItemStrokeWidth: 1,
          },
          scrollToContent: true,
        }}
        onChange={(sceneElements, appState) => {
          if (opensForbiddenDialog(appState.openDialog)) apiRef.current?.updateScene({ appState: { openDialog: null } })
          const version = sceneVersion(sceneElements)
          // The first change is Excalidraw settling the initial scene (text
          // measured, arrows bound); that is the baseline, not an edit.
          if (baseline.current === null) {
            baseline.current = version
            // `initialData.scrollToContent` only centres; a flow taller than
            // the dialog then opened cut off below its third step.
            requestAnimationFrame(() =>
              apiRef.current?.scrollToContent(undefined, { fitToViewport: true, viewportZoomFactor: 0.75 })
            )
            return
          }
          if (!dirty.current && version !== baseline.current) {
            dirty.current = true
            onDirtyChange(true)
          }
        }}
        theme={theme}
        viewModeEnabled={readOnly}
        langCode={langCode}
        UIOptions={{
          canvasActions: {
            loadScene: false,
            saveToActiveFile: false,
            saveAsImage: false,
            export: false,
            toggleTheme: false,
            changeViewBackgroundColor: false,
          },
          tools: { image: false },
        }}
        validateEmbeddable={() => false}
        aiEnabled={false}
      >
        <MainMenu>
          <MainMenu.DefaultItems.ClearCanvas />
          <MainMenu.DefaultItems.Help />
        </MainMenu>
      </Excalidraw>
    </div>
  )
}
