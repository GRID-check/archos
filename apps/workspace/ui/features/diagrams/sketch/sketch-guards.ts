/**
 * What the sketch editor refuses to open, kept out of `sketch-canvas.tsx` so a
 * spec can hold it without loading Excalidraw.
 *
 * Excalidraw 0.18.1 turns its AI tools on unless told otherwise (`aiEnabled`
 * defaults to true). They are text-to-diagram, the "Generate" group in the
 * extra-tools menu and the frame's "convert to code", and the package carries
 * `oss-ai.excalidraw.com` as its AI backend. The canvas passes
 * `aiEnabled={false}`, which removes those entries. One door stays open
 * whatever that prop says: the extra-tools menu offers "Mermaid to Excalidraw"
 * ungated, and the command palette reaches the same `ttd` dialog. Neither is a
 * way a Skizze is made here (Piloti draws a sketch fence, ADR-0146; a flow
 * becomes a sketch through `sketchFromModel`), so the dialog is closed the
 * moment it opens.
 */

/** The `openDialog` names the canvas closes on sight: text-to-diagram and mermaid-to-Excalidraw. */
export const FORBIDDEN_SKETCH_DIALOGS: ReadonlySet<string> = new Set(['ttd'])

/** True when Excalidraw's app state shows a dialog the sketch editor never offers. */
export function opensForbiddenDialog(openDialog: { name?: string } | null | undefined): boolean {
  return typeof openDialog?.name === 'string' && FORBIDDEN_SKETCH_DIALOGS.has(openDialog.name)
}
