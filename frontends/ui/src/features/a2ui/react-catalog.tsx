'use client'

/**
 * The Piloti catalog's React implementations, and the one place
 * `@a2ui/react` is imported (ADR-0065).
 *
 * Browser only. Since 0.13, `@a2ui/react` draws every component inside a
 * custom element of its own (`<a2ui-react-<name>>`, `display: contents`) and
 * defines that element's class when the module is evaluated, which throws
 * `HTMLElement is not defined` on the server. `A2uiCard` therefore imports
 * this module dynamically, in the browser, and draws a placeholder until it
 * has arrived; the server never evaluates it. What the server and the
 * fallback need (names, schemas, `preflight`) is in `catalog.tsx`.
 *
 * Each component is a contract from `catalog.tsx` plus a view drawn with this
 * product's atoms.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Catalog, MessageProcessor, type SurfaceModel } from '@a2ui/web_core/v0_9'
import { createComponentImplementation, type ReactComponentImplementation } from '@a2ui/react/v0_9'

import type { GridCard } from '@/shared/cards/schemas'
import { Tabs as UiTabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useHeightGlide } from '@/components/motion/height-glide'
import { cn } from '@/lib/utils'
import {
  A2UI_PROTOCOL_VERSION,
  cardComponentApi,
  catalogCardSchemas,
  ColumnApi,
  PILOTI_CATALOG_ID,
  RowApi,
  TabsApi,
  TextApi,
  TextBlock,
  useCardRenderer,
  useReportDrawn,
  type CardSchema,
} from './catalog'
import { cardToSurfaceMessages } from './surface-messages'

export { A2uiSurface } from '@a2ui/react/v0_9'

function cardComponent(schema: CardSchema): ReactComponentImplementation {
  const api = cardComponentApi(schema)
  const type = api.name
  return createComponentImplementation(api, function A2uiCardComponent({ props, context }) {
    const render = useCardRenderer()
    useReportDrawn()
    if (!render) return null
    // `display: contents`: no box of its own. The attribute is how the host
    // knows A2UI has drawn a real component rather than its placeholder.
    return (
      <div className="contents" data-a2ui-node={type}>
        {render({ ...(props as object), type } as GridCard, context.componentModel.id)}
      </div>
    )
  })
}

/**
 * Side by side where there is room, stacked where there is not. A container
 * query, not a breakpoint: the same surface sits in the answer column, a side
 * panel and a phone, and only its own width says whether two cards fit. 44rem
 * because a card under ~340px crowds its own margin (legal_basis's Fundstelle,
 * a calculation's operands): a Row goes side by side only on a surface wider
 * than that, and stacks in a narrow window or a side panel.
 */
function RowView({ ids, buildChild }: { ids: string[]; buildChild: (id: string) => ReactNode }) {
  useReportDrawn()
  return (
    <div className="@container" data-a2ui-node="Row">
      <div className="grid items-start gap-3 @[44rem]:grid-flow-col @[44rem]:auto-cols-fr">
        {ids.map((id) => (
          <div key={id} className="min-w-0">
            {buildChild(id)}
          </div>
        ))}
      </div>
    </div>
  )
}

const Row = createComponentImplementation(RowApi, ({ props, buildChild }) => (
  <RowView ids={props.children as string[]} buildChild={buildChild} />
))

function ColumnView({ ids, buildChild }: { ids: string[]; buildChild: (id: string) => ReactNode }) {
  useReportDrawn()
  return (
    <div className="flex flex-col gap-3" data-a2ui-node="Column">
      {ids.map((id) => (
        <div key={id} className="min-w-0">
          {buildChild(id)}
        </div>
      ))}
    </div>
  )
}

const Column = createComponentImplementation(ColumnApi, ({ props, buildChild }) => (
  <ColumnView ids={props.children as string[]} buildChild={buildChild} />
))

/**
 * Variants, one at a time: the product's own tabs atom (`components/ui/tabs`),
 * so a composed answer switches the way every other tab strip in the app does
 * — the gliding pill, the focus ring, the 44px touch floor.
 *
 * Switching is a swap the reader asked for, so it moves like one: the panel
 * area glides to the new panel's height (`useHeightGlide`) instead of shoving
 * the rest of the answer by the difference in one frame, and the new panel
 * fades in. Only after a switch — the first panel arrives with its card.
 *
 * On a phone the strip scrolls sideways, and a tapped variant half under the
 * edge stayed half under it. The chosen tab is brought fully into the strip,
 * by scrolling the strip alone: `scrollIntoView` would also scroll the page.
 */
function TabsView({ tabs, buildChild }: { tabs: { title: string; child: string }[]; buildChild: (id: string) => ReactNode }) {
  useReportDrawn()
  const [value, setValue] = useState(tabs[0]?.child)
  const [switched, setSwitched] = useState(false)
  const panelsRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  useHeightGlide(panelsRef, value)

  useEffect(() => {
    if (!switched) return
    const list = listRef.current
    const tab = list?.querySelector<HTMLElement>('[data-state="active"]')
    if (!list || !tab) return
    const listBox = list.getBoundingClientRect()
    const tabBox = tab.getBoundingClientRect()
    const overflowLeft = tabBox.left - listBox.left
    const overflowRight = tabBox.right - listBox.right
    if (overflowLeft >= 0 && overflowRight <= 0) return
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    list.scrollTo({
      left: list.scrollLeft + (overflowLeft < 0 ? overflowLeft : overflowRight),
      behavior: reduced ? 'auto' : 'smooth',
    })
  }, [value, switched])

  return (
    <UiTabs
      value={value}
      onValueChange={(next) => {
        setSwitched(true)
        setValue(next)
      }}
      className="gap-3"
      data-a2ui-node="Tabs"
    >
      <TabsList ref={listRef} className="max-w-full justify-start overflow-x-auto">
        {tabs.map((tab) => (
          <TabsTrigger key={tab.child} value={tab.child} className="flex-none">
            {tab.title}
          </TabsTrigger>
        ))}
      </TabsList>
      <div ref={panelsRef}>
        {tabs.map((tab) => (
          <TabsContent
            key={tab.child}
            value={tab.child}
            className={cn(
              'mt-0 min-w-0',
              switched && 'animate-in fade-in-0 duration-quick ease-out motion-reduce:animate-none'
            )}
          >
            {buildChild(tab.child)}
          </TabsContent>
        ))}
      </div>
    </UiTabs>
  )
}

const Tabs = createComponentImplementation(TabsApi, ({ props, buildChild }) => (
  <TabsView tabs={props.tabs as { title: string; child: string }[]} buildChild={buildChild} />
))

function TextView({ text }: { text: string }) {
  useReportDrawn()
  return <TextBlock text={text} />
}

const Text = createComponentImplementation(TextApi, ({ props }) => <TextView text={String(props.text)} />)

let catalog: Catalog<ReactComponentImplementation> | null = null

/** The catalog, built once on first use. */
export function pilotiCatalog(): Catalog<ReactComponentImplementation> {
  catalog ??= new Catalog(PILOTI_CATALOG_ID, A2UI_PROTOCOL_VERSION, [
    ...catalogCardSchemas().map(cardComponent),
    Row,
    Column,
    Tabs,
    Text,
  ])
  return catalog
}

/**
 * A card as a drawn-ready A2UI surface on a processor of its own. Throws what
 * the processor throws for a message it refuses; `A2uiCard` falls back on it.
 */
export function buildSurface(card: GridCard, surfaceId: string): SurfaceModel<ReactComponentImplementation> | null {
  const processor = new MessageProcessor<ReactComponentImplementation>([pilotiCatalog()])
  processor.processMessages(cardToSurfaceMessages(card, surfaceId))
  return processor.model.getSurface(surfaceId) ?? null
}
