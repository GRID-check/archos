/**
 * `diagrams` namespace — a diagram Piloti drew, in the answer and in the project.
 *
 * Two audiences share this namespace and they need different registers. The
 * reader of an answer gets one line and a button; the developer whose renderer
 * posted something the server refused gets a sentence naming what was wrong,
 * because that message is the only debugging surface a browser has.
 *
 * The `rejected.*` set is one member per `DIAGRAM_SVG_REJECTIONS` entry, and
 * `diagram-copy.spec.ts` fails when the tuple grows without the copy — a
 * refusal that renders as `undefined` is worse than one that renders in the
 * wrong language.
 */
export const diagrams = {
  /**
   * The line that carries the doctrine to the reader.
   *
   * Fifteen schematic cards in this product draw geometry the RENDERER computes,
   * so „a card cannot show a diagram that disagrees with its own numbers". A
   * diagram written as mermaid has no such guarantee — the model's text IS the
   * geometry. So the drawing says, in one line and everywhere it appears, that
   * it is not claiming a measurement.
   */
  schematicOnly: 'Schematic — no dimensions are claimed.',
  /** The file name a diagram gets when neither the source nor the surface names it. */
  defaultTitle: 'Diagram',
  fallback: 'This diagram could not be drawn. Its source is above.',
  /**
   * What a drawn diagram is called to a screen reader when its source names no
   * title: the kind of picture, never `schematicOnly`, which is a claim about
   * measurement the drawing does not make.
   */
  kind: {
    flow: 'Flow diagram',
    map: 'Map of parts',
    handoff: 'Hand-over sequence',
    schedule: 'Schedule',
    shares: 'Shares',
  },
  /** The scrolling frame around a graph, named apart from the graph inside it so the two are not announced alike. */
  scrollable: '{name}, scrolls sideways',
  file: {
    action: 'File in project',
    pending: 'Filing…',
    done: 'Filed in the project',
    open: 'Open in project',
    failed: 'Could not be filed',
    /**
     * The SVG landed and the PDF did not — the route's `pdf: null`, 201.
     *
     * Naming both halves beats "done", and it beats "could not be filed" by
     * more: a filed, quota-charged SVG is in Berichte either way, and the one
     * message that makes a reader stop looking for it is the one that says
     * nothing happened. What to do about it is not in this sentence — it is
     * the `open` link and the `completePdf` button beside it.
     */
    partial: 'The image was filed; the PDF was not.',
    /**
     * The retry, labelled for what it actually does.
     *
     * Filing is idempotent per (run, producer), so pressing it again files only
     * the missing half. "File in project" would promise a second copy of the
     * drawing; this promises the half that is missing.
     */
    completePdf: 'Add the PDF',
  },
  /**
   * The provenance block printed in the PDF itself.
   *
   * The grey byline in the Files pane is chrome; this line is the artifact, and
   * the artifact is what reaches the Behörde — the same argument the `.docx`
   * export makes for its first-page block.
   */
  marking:
    'Created by Piloti — AI-generated, not reviewed. Schematic: no dimensions are claimed. Not a certificate; check every statement before passing this on.',
  /**
   * The same block for a drawing a person reworked in the sketch editor before
   * filing it. „Created by Piloti" would be half false; editing is not a review
   * either, so „not reviewed" stays. „Not to scale" because a person's hand
   * can now have drawn anything, a site outline included.
   */
  markingEdited:
    'Drafted by Piloti, edited by a person — AI-assisted, not reviewed. Sketch: not to scale, no dimensions are claimed. Not a certificate; check every statement before passing this on.',
  /**
   * The same block for a sketch Piloti drew itself (an ```excalidraw fence,
   * ADR-0145) and the reader filed as drawn. „Sketch: not to scale" rather than
   * „Schematic": a sketch places things by hand, a site outline included.
   */
  markingSketch:
    'Created by Piloti — AI-generated, not reviewed. Sketch: not to scale, no dimensions are claimed. Not a certificate; check every statement before passing this on.',
  /**
   * The sketch editor: Excalidraw, opened on a drawing Piloti made, so a person
   * can rework it and file their own version. Only flows and Gliederungen have
   * one; the other views are not node graphs.
   */
  sketch: {
    action: 'Edit as sketch',
    title: 'Edit sketch',
    description: 'Starts from Piloti’s drawing. A sketch is not to scale and claims no dimensions.',
    loading: 'Loading the canvas…',
    loadFailed: 'The canvas could not be loaded.',
    save: 'File in project',
    saving: 'Filing…',
    close: 'Close',
    /** A close with unsaved changes asks once, in place, rather than losing the work. */
    discardQuestion: 'Discard your changes?',
    discard: 'Discard',
    keepEditing: 'Keep editing',
    /** The default file name, when the drawing's source names none. */
    defaultTitle: 'Sketch',
    /** Beside a sketch Piloti drew, where the reader is: the doctrine in one line. */
    notToScale: 'Sketch — not to scale, no dimensions.',
    fallback: 'This sketch could not be drawn. Its source is above.',
  },
  rejected: {
    empty: 'The diagram was empty.',
    'too-large': 'The diagram is too large to file.',
    'malformed-xml': 'The diagram is not well-formed XML.',
    'doctype-or-entity': 'The diagram declares a document type or an entity, which is not allowed.',
    'not-svg': 'The file is not an SVG.',
    'missing-viewport': 'The diagram states no size, so it cannot be placed on a page.',
    'script-element': 'The diagram contains a script.',
    'foreign-object': 'The diagram embeds HTML (foreignObject). Render it with htmlLabels turned off.',
    'style-element':
      'The diagram carries a stylesheet. Flatten the styles onto the elements before filing it.',
    'unsupported-element': 'The diagram uses an element this product does not draw.',
    'event-handler-attribute': 'The diagram carries an event handler.',
    'external-reference': 'The diagram references something outside itself.',
    'source-too-large': 'The diagram source is too long.',
    /**
     * Depth, not size: four walks recurse once per level, so nesting a browser
     * can still draw is nesting the server and the PDF renderer cannot survive.
     * Named rather than folded into `too-large`, because the remedy is a
     * different one — flatten the grouping, not shrink the drawing.
     */
    'too-deep': 'The diagram nests its elements too deeply to be filed.',
  },
}
