/**
 * A sketch fence drawn: Excalidraw turns the skeletons Piloti wrote into a
 * scene, and the scene into the SVG the chat shows and the project files
 * (ADR-0145).
 *
 * The second module that imports `@excalidraw/excalidraw`, and like the first
 * (`sketch-canvas.tsx`) it is reached only by a dynamic import, from
 * `components/sketch-figure.tsx`, once a sketch fence is on screen. A reader
 * who never meets a sketch downloads none of it; one who does pays the 2.5 MB
 * once, and the editor reuses the chunk.
 *
 * What is drawn is the paper copy only: a sketch is drawn on white, filed on
 * white, and shown on a white sheet in both themes, as the editor shows it.
 * `exportToSvg`'s dark mode is a CSS filter the SVG validator would refuse and
 * the PDF cannot draw, and a sketch shown in other colours than it is filed in
 * would be the "what got filed is not what I saw" defect `diagrams.md` names.
 */

import './excalidraw-assets'
import { convertToExcalidrawElements, exportToSvg, serializeAsJSON } from '@excalidraw/excalidraw'
import type { SceneSkeleton } from '@/lib/diagrams/sketch-fence'
import { fileableSketchSvg } from './sketch-svg'

type Skeletons = Parameters<typeof convertToExcalidrawElements>[0]

export interface RenderedSketch {
  /** The paper SVG, through the server's validator: what is shown and what is filed. */
  svg: string
  /** The scene as an `.excalidraw` document, the source a filed sketch carries. */
  scene: string
}

export async function renderSketch(skeletons: readonly SceneSkeleton[]): Promise<RenderedSketch> {
  const elements = convertToExcalidrawElements(skeletons as unknown as Skeletons)
  const appState = { exportBackground: true, viewBackgroundColor: '#ffffff', exportWithDarkMode: false }
  const svg = await exportToSvg({ elements, appState, files: null, exportPadding: 16, skipInliningFonts: true })
  return {
    svg: fileableSketchSvg(svg),
    scene: serializeAsJSON(elements, appState, {}, 'local'),
  }
}
