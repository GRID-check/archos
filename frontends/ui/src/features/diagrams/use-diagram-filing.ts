'use client'

/**
 * Filing one drawing into the project — the whole write, once.
 *
 * Two surfaces draw model-authored mermaid and both must be able to save it:
 * the ```mermaid FENCE inside an answer, and the `diagram` CARD. Which one a
 * reader gets is not their choice and not a property of the drawing — it is
 * whichever shape the model happened to emit — so „Im Projekt ablegen" existing
 * on one and not the other made the same Verfahrensablauf filable or not by
 * accident.
 *
 * This is the half neither surface may own. The POST, the run id, the title
 * resolution, the five states and — the part that would actually have drifted —
 * what a 201 with `pdf: null` means are one implementation, because two copies
 * of a `partial` branch will disagree about an error message inside a month and
 * the disagreement is invisible until someone files a half-broken diagram.
 *
 * ## Why no `CardInteraction`
 *
 * The card is `presentational` in `CARD_INTERACTIVITY` (ADR-0030) and STAYS
 * presentational with this button, which sounds like a contradiction and is
 * not. That classification governs whether a decision is PERSISTED, and the
 * reason not to persist this one is unchanged and good: a `CardInteraction` is
 * a `CardDecision` plus a timestamp and nothing else, so storing `filed` would
 * record that it happened and lose the document id — the answer's only pointer
 * into the Files pane — while also removing the button that could give it back.
 *
 * What that argues against is the STORAGE, and the button never needed it.
 * Filing keys on (answer, source hash, producer) — `diagramRunId` and migration
 * 0065's index — so pressing it after a reload finds the same document and
 * hands the reader the same link. Nothing to remember, nothing to be annoyed to
 * do twice, no persisted decision. `card-decision.ts` records this reasoning at
 * the `diagram` entry.
 *
 * ## Two drawings with one identity
 *
 * `diagramRunId(answerId, source)` is a hash of the SOURCE, so a card and a
 * fence carrying byte-identical mermaid in one answer collide on purpose. That
 * is the right outcome — it is one picture and the office wants one file — and
 * it is the same rule two identical fences already follow. The visible
 * consequence is that the title of whichever was filed FIRST is the name in the
 * Files pane; the second press finds the document already there and files only
 * what is missing rather than renaming it. Naming a file twice would be the
 * worse behaviour: it would make the Files pane disagree with itself depending
 * on which control a reader last touched.
 */

import { useCallback, useState } from 'react'
import { DiagramFilingError, fileDiagram } from '@/adapters/api/diagrams-client'
import { useTranslations } from '@/i18n'
import { diagramRunId, useDiagramFilingTarget, type DiagramFilingTarget } from './diagram-filing-context'

export type DiagramFilingState =
  | { kind: 'idle' }
  | { kind: 'filing' }
  | { kind: 'filed'; documentId: string }
  /**
   * The SVG landed and the PDF did not (`pdf: null`, 201).
   *
   * It carries the SVG's document id for the same reason `filed` does: the half
   * that IS in the project is the half the reader most needs to open, and a
   * state that says "half of it is filed" without saying where sends them to
   * hunt through Berichte for a file they are not sure exists.
   */
  | { kind: 'partial'; documentId: string }
  | { kind: 'failed'; message: string }

export interface DiagramFiling {
  state: DiagramFilingState
  /** Where this drawing may be filed, or `null` — then the surface offers nothing. */
  target: DiagramFilingTarget | null
  /** The document once one exists, for the „Im Projekt öffnen" affordance. */
  documentId: string | null
  /** The paper bytes exist, or can be drawn on demand, and there is somewhere to put them. */
  canFile: boolean
  file: () => Promise<void>
}

/**
 * `--- title: X ---` front matter, which is the only title a SOURCE can carry.
 *
 * A scan line by line, not a regex: the model writes the source, and the two
 * patterns this replaced (`\n\s*---` after a lazy body, `^\s*title:\s*(.+?)\s*$`)
 * backtracked quadratically over a long run of blank lines or spaces in it.
 */
export function titleFromSource(source: string): string | null {
  const lines = source.split('\n')
  let i = 0
  while (i < lines.length && lines[i].trim() === '') i++
  if (lines[i]?.trim() !== '---') return null
  let title: string | null = null
  for (i++; i < lines.length; i++) {
    const line = lines[i].trim()
    if (line.startsWith('---')) return title
    if (title === null && line.startsWith('title:')) title = line.slice('title:'.length).trim().slice(0, 200) || null
  }
  // Front matter never closed: not front matter.
  return null
}

export interface DiagramFilingOptions {
  source: string
  /**
   * The PAPER render — `fileSvg` from `useRenderedDiagram`, never `svg`. The
   * bytes that go into the project are the ones a document is printed in,
   * whatever theme the reader is in, and passing the themed copy here is the
   * regression that puts a charcoal drawing on a white page.
   */
  fileSvg: string | null
  /**
   * Draws the paper copy on demand, for a surface that shows its own view and
   * has no `fileSvg` until the reader files (`renderPaperDiagram`). Used only
   * while `fileSvg` is null.
   */
  renderFileSvg?: () => Promise<string>
  /**
   * A title the SURFACE knows and the source does not. The `diagram` card has a
   * real one the model wrote for this drawing; a fence has only whatever front
   * matter the source carries. Better provenance wins, so this is checked first.
   */
  title?: string | null
  /**
   * A drawing whose source and picture exist only when the person files it:
   * the sketch editor, whose scene changes with every stroke. Called once per
   * press, instead of `source` and `fileSvg`, and the result is filed as an
   * Excalidraw scene a person edited (`edited: true`).
   */
  prepareSketch?: () => Promise<{ source: string; svg: string }>
  /**
   * Whether a person changed the sketch before filing it. True for the editor,
   * the default; false for a sketch Piloti drew in an ```excalidraw fence and
   * the reader files as drawn (ADR-0146). An unedited sketch is keyed by its
   * fence, so filing it again after a reload finds the same document, and its
   * files say Piloti made it.
   */
  edited?: boolean
}

export function useDiagramFiling({
  source,
  fileSvg,
  renderFileSvg,
  title,
  prepareSketch,
  edited = true,
}: DiagramFilingOptions): DiagramFiling {
  const t = useTranslations('diagrams')
  const target = useDiagramFilingTarget()
  const [state, setState] = useState<DiagramFilingState>({ kind: 'idle' })

  const file = useCallback(async () => {
    if (!target || (!fileSvg && !renderFileSvg && !prepareSketch)) return
    // Feedback inside 100ms: this lands synchronously, before the network is
    // touched, so the control the reader pressed is replaced by „Wird abgelegt …"
    // in the same frame as the press.
    setState({ kind: 'filing' })
    try {
      const sketch = prepareSketch ? await prepareSketch() : null
      const svg = sketch?.svg ?? fileSvg ?? (await renderFileSvg?.())
      if (!svg) throw new Error('no paper copy to file')
      const filedSource = sketch?.source ?? source
      const filed = await fileDiagram(target.projectId, {
        // An edited sketch is keyed by its own scene: two different edits of
        // one drawing are two files, the same edit filed twice is one. A
        // sketch filed as drawn is keyed by its fence, like a mermaid one.
        runId: diagramRunId(target.answerId, sketch && edited ? filedSource : source),
        title:
          title?.trim() ||
          titleFromSource(source) ||
          target.title ||
          (sketch ? t('sketch.defaultTitle') : t('defaultTitle')),
        sourceKind: sketch ? 'excalidraw' : 'mermaid',
        source: filedSource,
        // The drawing on screen, in the colours a document is printed in.
        // Same source, same fonts, same layout — only the palette differs, and
        // the reason it has to is in `./diagram-palette.ts`.
        svg,
        answerId: target.answerId,
        ...(sketch && edited ? { edited: true } : {}),
        ...(target.conversationId ? { conversationId: target.conversationId } : {}),
      })
      // The SVG row is the one a reader opens; the PDF is the one they attach.
      // A missing PDF is a smaller success rather than a failure: the route
      // answers 201 with `pdf: null` when only the SVG landed, because the SVG
      // is filed and quota-charged either way.
      setState({ kind: filed.pdfFiled ? 'filed' : 'partial', documentId: filed.svgDocumentId })
    } catch (error) {
      console.debug('[diagrams] filing failed', error)
      // A refusal names its own sentence when the server gave one.
      const message = error instanceof DiagramFilingError && error.serverMessage !== null ? error.serverMessage : t('file.failed')
      setState({ kind: 'failed', message })
    }
  }, [target, fileSvg, renderFileSvg, prepareSketch, edited, source, title, t])

  return {
    state,
    target,
    documentId: state.kind === 'filed' || state.kind === 'partial' ? state.documentId : null,
    canFile: Boolean(target && (fileSvg || renderFileSvg || prepareSketch)),
    file,
  }
}
