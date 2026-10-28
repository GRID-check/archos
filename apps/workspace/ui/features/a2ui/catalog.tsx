'use client'

/**
 * The Piloti A2UI catalog: every card type as an A2UI component, the three
 * layout components an answer may compose them with, and `Text`, a run of the
 * answer's own Markdown (ADR-0065).
 *
 * This module is the catalog's contract: each component's name and props
 * schema, the contexts its components read, and `preflight`, the check a
 * surface passes before it is drawn. It is safe to import on the server. The
 * React implementations live in `react-catalog.tsx`, which imports
 * `@a2ui/react` and is loaded in the browser only (`A2uiCard`): since 0.13
 * that package defines a custom element class at import, which throws where
 * there is no DOM.
 *
 * Custom-only. A2UI's basic catalog is not registered: it draws Lit custom
 * elements with A2UI's own styles, not this product's atoms. `Row`,
 * `Column`, `Tabs` and `Text` take the basic catalog's NAMES and shapes (so a
 * surface is plain A2UI v0.9) and are drawn with this product's atoms. `Text`
 * is narrowed to a `text` of Markdown: it is what lets a tab hold a table,
 * which the Markdown-first answer never puts on a card.
 *
 * A card component's props are that card's own fields, validated by the card's
 * generated Zod schema (`apps/workspace/shared/cards/generated.ts`) — the same schema a card
 * outside A2UI is validated by, so there is one contract, not two. How a card
 * is DRAWN is not this module's business: the host hands a renderer down
 * (`CardRenderer`), which keeps `features/a2ui` free of every card component
 * and of the import cycle that would bring.
 *
 * A2UI 0.14 speaks Zod 3, and this module is the seam. `@a2ui/web_core`
 * depends on `zod@^3` and reads a component's schema through Zod 3 internals
 * (`_def.typeName`) to find which props hold child ids and how to bind each
 * prop, and formats a refusal from `ZodError.errors`, which Zod 4 dropped. So
 * the layout and `Text` schemas are built with Zod 3 around A2UI's own
 * `componentId()`, and a card's Zod 4 schema is handed over wrapped in a Zod 3
 * schema that runs it ({@link forA2ui}). `zod-v3` is an alias of the exact Zod
 * A2UI depends on (`npm:zod@3.25.76`): with one version, TypeScript reads both
 * as one package; `zod/v3` from Zod 4 is another and does not typecheck
 * against A2UI's types. Move these to Zod 4, and drop the alias, when A2UI
 * does.
 */

import { createContext, useContext, useLayoutEffect, type ReactNode } from 'react'
import { z } from 'zod'
import { z as z3 } from 'zod-v3'
import { Catalog, componentId, type ComponentApi } from '@a2ui/web_core/v0_9'

import { gridCardSchema, type GridCard } from '@/shared/cards/schemas'
import { MarkdownRenderer } from '@/shared/components/MarkdownRenderer/MarkdownRenderer'
import { useNestedMarkdownPlugins } from '@/shared/components/MarkdownRenderer/nested-plugins-context'

/** The catalog's identity on the wire; `createSurface.catalogId` must equal it. */
export const PILOTI_CATALOG_ID = 'https://piloti.at/a2ui/catalogs/cards/v1'

/**
 * The A2UI protocol version the catalog and every surface speak: v0.9, the
 * current stable specification. Written as the catalog writes it (a bare
 * version, as the basic catalog does); the messages carry it as `v0.9`.
 */
export const A2UI_PROTOCOL_VERSION = '0.9'

/** The layout components, named as in A2UI's basic catalog. */
export const LAYOUT_COMPONENTS = ['Row', 'Column', 'Tabs'] as const

/** The one leaf that is not a card: Markdown, named as in A2UI's basic catalog. */
export const TEXT_COMPONENT = 'Text'

/**
 * Draws one card. `leafId` is the component's id inside its surface: `root`
 * for a lone card, the model's own id for a card inside a composition.
 */
export type CardRenderer = (card: GridCard, leafId: string) => ReactNode

const CardRendererContext = createContext<CardRenderer | null>(null)
export const CardRendererProvider = CardRendererContext.Provider
export const useCardRenderer = () => useContext(CardRendererContext)

/**
 * Called once A2UI has drawn a real component. A layout effect, so it runs in
 * the commit that mounted the component, before the browser paints: the host
 * takes its placeholder down and shows A2UI's drawing without a frame of
 * A2UI's own "[Loading root...]". `A2uiCard` passes the same news to whatever
 * holds the card's place above it (a streamed card's `CardSlot`).
 */
const DrawnContext = createContext<(() => void) | null>(null)
export const DrawnProvider = DrawnContext.Provider
export const useDrawnReporter = () => useContext(DrawnContext)

export function useReportDrawn() {
  const report = useDrawnReporter()
  useLayoutEffect(() => report?.(), [report])
}

export type CardSchema = (typeof gridCardSchema.options)[number]

/** A card schema's `type` literal; one card defaults it, which wraps the literal. */
export function cardTypeOf(schema: CardSchema): string {
  const field: z.ZodType = schema.shape.type
  const literal = field instanceof z.ZodDefault ? field.unwrap() : field
  return (literal as z.ZodLiteral<string>).value
}

/**
 * A Zod 4 schema as the Zod 3 schema A2UI reads: it accepts what `schema`
 * accepts and refuses with `schema`'s own issues. A2UI finds no child ids in
 * it, which is right for a card (a leaf), and binds every prop as a static
 * value, which is what a card's props are.
 */
function forA2ui(schema: z.ZodType): z3.ZodType {
  return z3.unknown().superRefine((value, ctx) => {
    const result = schema.safeParse(value)
    if (result.success) return
    for (const issue of result.error.issues) {
      ctx.addIssue({ code: z3.ZodIssueCode.custom, message: issue.message, path: issue.path.filter((step) => typeof step !== 'symbol') })
    }
  })
}

/** A card component's props: the card's fields without its `type`, which is the component name. */
export function cardComponentApi(schema: CardSchema): ComponentApi {
  const props = (schema as z.ZodObject).omit({ type: true })
  return { name: cardTypeOf(schema), schema: forA2ui(props) }
}

export const RowApi = {
  name: 'Row',
  schema: z3
    .object({
      // Static ids only, as `SurfaceCard` requires: A2UI's data-bound
      // `{componentId, path}` form would draw an empty box with no fallback.
      children: z3.array(componentId()),
      justify: z3.enum(['start', 'center', 'end', 'spaceBetween', 'spaceAround', 'spaceEvenly', 'stretch']).optional(),
      align: z3.enum(['start', 'center', 'end', 'stretch']).optional(),
    })
    .strict(),
}
export const ColumnApi = { ...RowApi, name: 'Column' }
export const TabsApi = {
  name: 'Tabs',
  schema: z3
    .object({
      tabs: z3.array(z3.object({ title: z3.string().trim().min(1), child: componentId() }).strict()).min(1),
    })
    .strict(),
}

export const TextApi = { name: TEXT_COMPONENT, schema: z3.object({ text: z3.string().trim().min(1) }).strict() }

/**
 * A run of the answer's Markdown, drawn by the renderer the prose is drawn by,
 * with the answer's citation plugin (`NestedMarkdownPluginsProvider`), so a
 * table in a tab looks and cites exactly like one in the prose.
 */
export function TextBlock({ text }: { text: string }) {
  const plugins = useNestedMarkdownPlugins()
  return (
    <div className="min-w-0" data-a2ui-node={TEXT_COMPONENT}>
      <MarkdownRenderer content={text} remarkPlugins={plugins} />
    </div>
  )
}

/**
 * The card types the catalog draws, one component each. `surface` is not a
 * component: it is the envelope a composition travels in, unpacked into its
 * own components by `cardToSurfaceMessages`.
 */
export function catalogCardSchemas(): CardSchema[] {
  return gridCardSchema.options.filter((schema) => cardTypeOf(schema) !== 'surface')
}

let catalogApi: Catalog<ComponentApi> | null = null

/** The catalog's components as schemas only, built once: what `preflight` checks a surface against. */
export function pilotiCatalogApi(): Catalog<ComponentApi> {
  catalogApi ??= new Catalog(PILOTI_CATALOG_ID, A2UI_PROTOCOL_VERSION, [
    ...catalogCardSchemas().map(cardComponentApi),
    RowApi,
    ColumnApi,
    TabsApi,
    TextApi,
  ])
  return catalogApi
}

/**
 * Card types that may not be a leaf of a surface. Mirrors
 * `SURFACE_EXCLUDED_LEAVES` in `src/aiq_agent/cards/models.py`, which refuses
 * them when the surface is written: system cards are pushed by tools, and an
 * interactive card's decision is
 * keyed by its position in the message (`card-decision.ts`), which a card
 * inside a surface does not have. The catalog still registers them, because a
 * card outside a surface is drawn through it too, so the refusal lives here.
 */
export const SURFACE_EXCLUDED_LEAVES: ReadonlySet<string> = new Set([
  'surface',
  'memory_proposal',
  'document_grid',
  'document_draft',
  'task_created',
  'file_operation_proposal',
  'operation_proposal',
  'project_profile_patch',
  'canvas_activity',
  'look',
  'revision_compare',
])

/**
 * Why the catalog would not draw these components, or null when it would.
 *
 * A2UI draws an unknown component as red "Unknown component type" text inside
 * the answer and an invalid one as its validation message. Neither may reach a
 * reader, so a surface is checked here first and, on any failure, drawn
 * without A2UI (`A2uiCard`'s fallback). A leaf the backend would have refused
 * is refused here too: a stored surface from before that check, or one that
 * reached the client another way, must not draw an interactive card whose
 * decision has nowhere to be kept. So is a surface that is not a tree
 * ({@link structuralRefusal}).
 *
 * `surface: false` is a lone card's one-component list: it sits in the message
 * itself, not inside a surface, so no leaf is excluded and a stored
 * `summary` or `memory_proposal` draws through the catalog like any other card.
 */
export function preflight(components: Record<string, unknown>[], { surface = true } = {}): string | null {
  const registry = pilotiCatalogApi().components
  for (const { id, component, ...props } of components) {
    if (surface && SURFACE_EXCLUDED_LEAVES.has(String(component))) {
      return `'${String(id)}': a '${String(component)}' cannot sit inside a surface`
    }
    const api = registry.get(String(component))
    if (!api) return `'${String(id)}': no component '${String(component)}' in the catalog`
    const result = api.schema.safeParse(props)
    if (!result.success) return `'${String(id)}' (${String(component)}): ${result.error.issues[0]?.message ?? 'invalid'}`
  }
  return structuralRefusal(components)
}

/** The ids a component points at: a Row's or Column's children, a Tabs' tab children. */
function childIds(component: Record<string, unknown>): string[] {
  if (Array.isArray(component.children)) return component.children.map(String)
  if (!Array.isArray(component.tabs)) return []
  return component.tabs.map((tab) => String((tab as { child?: unknown }).child))
}

/**
 * Why these components are not one tree under `root`, or null when they are.
 *
 * The same checks `a2ui-core` runs when a surface is written (ADR-0065):
 * unique ids, a `root`, every reference resolving, each component referenced
 * at most once, and every component reachable from `root` without a cycle.
 * A2UI itself draws a dangling child or a cycle as a grey "[Loading id...]"
 * placeholder, which would reach the reader AND report the surface drawn.
 */
export function structuralRefusal(components: Record<string, unknown>[]): string | null {
  const byId = new Map<string, Record<string, unknown>>()
  for (const component of components) {
    const id = String(component.id)
    if (byId.has(id)) return `'${id}': the id is used twice`
    byId.set(id, component)
  }
  if (!byId.has('root')) return "no 'root' component"
  const referenced = new Set<string>()
  for (const [id, component] of byId) {
    for (const child of childIds(component)) {
      if (!byId.has(child)) return `'${id}': child '${child}' does not exist`
      if (referenced.has(child)) return `'${child}': referenced more than once`
      referenced.add(child)
    }
  }
  // Every component referenced at most once, so a walk from `root` that meets
  // a component twice has gone round a cycle.
  const reached = new Set<string>()
  const pending = ['root']
  while (pending.length > 0) {
    const id = pending.pop() as string
    if (reached.has(id)) return `'${id}': the surface has a cycle`
    reached.add(id)
    pending.push(...childIds(byId.get(id) as Record<string, unknown>))
  }
  const orphan = [...byId.keys()].find((id) => !reached.has(id))
  return orphan ? `'${orphan}': not reachable from 'root'` : null
}
