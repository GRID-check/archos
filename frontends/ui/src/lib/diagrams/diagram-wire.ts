/**
 * The body of `POST /api/projects/[id]/diagrams`, kept out of the route file so
 * the route and the MCP catalog (`lib/agent-api/catalog/bim.ts`) parse against
 * one schema.
 */

import { z } from 'zod'
import { DIAGRAM_SOURCE_KINDS, MAX_DIAGRAM_SOURCE_BYTES, MAX_DIAGRAM_SVG_BYTES } from './diagram-sources'

export const fileDiagramSchema = z.object({
  /**
   * The chat answer the diagram was drawn in, plus a hash of its source. It is
   * `authored_by_ref` and half the idempotency key (migrations 0065/0066), so
   * pressing the button twice on one diagram files nothing twice.
   *
   * The WIRE name is still `runId`, and it is the one place this change did not
   * reach: the browser that sends it (`features/diagrams`) is what would have to
   * change with it, and renaming a request field is a coordinated deploy rather
   * than a rename. Everything downstream of `parseJsonBody` calls it what it is;
   * this line is the seam, and it is worth one comment rather than a wrong name
   * spreading inwards from it.
   */
  runId: z.string().min(1).max(200),
  title: z.string().min(1).max(200),
  sourceKind: z.enum(DIAGRAM_SOURCE_KINDS),
  /**
   * Bounded here as well as in `acceptDiagram`, and by the LARGEST kind's cap:
   * this schema does not know which kind is in the same body, so the per-kind
   * cap (32 KiB mermaid, 512 KiB excalidraw) stays where the kind is known and
   * this one only keeps an unbounded string out of the validator.
   *
   * The caps count bytes and `.max()` counts UTF-16 code units, which is safe
   * in this direction only: a code unit is never fewer than one UTF-8 byte, so
   * a string this admits can still be refused for its byte length, and one it
   * refuses could never have passed the byte check.
   */
  source: z.string().min(1).max(MAX_DIAGRAM_SOURCE_BYTES),
  svg: z.string().min(1).max(MAX_DIAGRAM_SVG_BYTES),
  /**
   * The conversation the diagram was drawn in. A thread that drew on a
   * restricted folder files only into a folder restricted at least as narrowly
   * (ADR-0087). Authorized as a read of that thread before it is used.
   */
  conversationId: z.string().min(1).max(128).optional(),
  /**
   * The answer message the diagram was drawn in, when the surface knows it.
   * Only used to find that turn's Langfuse trace for the `diagram-filed` score;
   * the identity of the filed files stays `runId`.
   */
  answerId: z.string().min(1).max(128).optional(),
  /**
   * A person changed the drawing before filing it (the sketch editor). The
   * files then say so in their own bytes: „Von Piloti entworfen, von einer
   * Person bearbeitet" instead of „Von Piloti erstellt". The machine marking is
   * unchanged (`AIHumanReviewed=false`): editing a sketch is not a Freigabe.
   */
  edited: z
    .boolean()
    .optional()
    .describe('True when a person edited the drawing before filing it; the files then name both authors'),
})
