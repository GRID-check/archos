/**
 * What an MCP Apps view draws where the A2UI catalog would draw Markdown
 * (ADR-0142). The A2UI catalog's `Text` leaf (`features/a2ui/catalog.tsx`) is
 * the answer's Markdown renderer, which brings mermaid, KaTeX, the diagram
 * views and the chat stores: about 7 MB a view never uses, since a view draws
 * one card from a tool result and never a composed surface with prose in it.
 * `scripts/build-mcp-app-views.ts` resolves the renderer's module to this file
 * for the views only; Piloti's own pages are unchanged. Should a view ever be
 * handed a `Text` leaf, its words are shown as they are, never dropped, except
 * a sketch's JSON (ADR-0146), which no reader can use: it becomes one word.
 */

import type { FC } from 'react'

const SKETCH_FENCE = /^[ \t]*(`{3,}|~{3,})[ \t]*excalidraw[^\n]*\n[\s\S]*?^[ \t]*\1[ \t]*$/gim

export const MarkdownRenderer: FC<{ content: string }> = ({ content }) => (
  <p className="text-foreground text-sm whitespace-pre-wrap">{content.replace(SKETCH_FENCE, '[Skizze]')}</p>
)
