'use client'

/**
 * One card slot, drawn through A2UI (ADR-0065).
 *
 * A slot is a lone card or a composed `surface`; either becomes an A2UI
 * surface (`cardToSurfaceMessages`) on a processor of its own, and
 * `A2uiSurface` draws it with the Piloti catalog, whose card components call
 * back into `render`. It is drawn once, by A2UI:
 *
 *  - **Until A2UI has drawn.** The renderer (`react-catalog.tsx`) is loaded
 *    in the browser only, so the server and the hydrating pass draw a
 *    `CardPlaceholder`. `A2uiSurface` then resolves its tree in a
 *    subscription, so its first frame is a grey "[Loading root...]". The
 *    surface is mounted hidden behind the placeholder and shown in the commit
 *    its first real component reports itself (`useReportDrawn`, a layout
 *    effect), before paint.
 *  - **On failure.** A message A2UI refuses, a renderer that will not load,
 *    or a render that throws inside it, falls back to the direct card: a card is never lost to the library.
 *    A surface falls back to its cards stacked in order.
 *
 * Either way, whatever holds the card's place (a `DrawnProvider` above it) is
 * told once the card is on screen.
 */

import {
  Component,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ErrorInfo,
  type ReactNode,
} from 'react'

import type { GridCard } from '@/shared/cards/schemas'
import { CardPlaceholder } from '@/features/grid-cards/components/CardPlaceholder'
import { CardRendererProvider, DrawnProvider, preflight, TextBlock, useDrawnReporter, type CardRenderer } from './catalog'
import { surfaceComponents, surfaceLeaves } from './surface-messages'

interface A2uiCardProps {
  card: GridCard
  /** Unique within the page; the surface id. */
  surfaceKey: string
  render: CardRenderer
}

/** The direct drawing: the card itself, or a surface's leaves stacked in order. */
function Direct({ card, render }: Pick<A2uiCardProps, 'card' | 'render'>) {
  if (card.type !== 'surface') return <>{render(card, 'root')}</>
  return (
    <div className="flex flex-col gap-3">
      {surfaceLeaves(card).map(({ id, leaf }) => (
        <div key={id}>{'text' in leaf ? <TextBlock text={leaf.text} /> : render(leaf, id)}</div>
      ))}
    </div>
  )
}

type FallbackProps = { fallback: ReactNode; onFail: (() => void) | null; children: ReactNode }

class Fallback extends Component<FallbackProps, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.warn('[A2UI] surface render failed; drawing the card directly', error, info.componentStack)
    this.props.onFail?.()
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children
  }
}

type Renderer = typeof import('./react-catalog')

/**
 * The renderer module, once the browser has it: `'failed'` if it would not
 * load, `null` until then and always on the server. The import starts when
 * this module is first evaluated in the browser, well before a thread's cards
 * arrive, so a card normally mounts with the renderer already here and draws
 * in its first commit, as it did when the renderer was a static import.
 */
let rendererModule: Renderer | 'failed' | null = null
const rendererListeners = new Set<() => void>()
const rendererLoad: Promise<void> =
  typeof window === 'undefined'
    ? Promise.resolve()
    : import('./react-catalog')
        .then((loaded) => {
          rendererModule = loaded
        })
        .catch((error: unknown) => {
          console.warn('[A2UI] renderer failed to load; drawing cards directly', error)
          rendererModule = 'failed'
        })
        .finally(() => rendererListeners.forEach((listener) => listener()))
/** Settles once the renderer has loaded or failed; a spec that checks a card in the commit it renders awaits it first. */
export const rendererSettled = (): Promise<void> => rendererLoad
const subscribeRenderer = (listener: () => void) => {
  rendererListeners.add(listener)
  return () => rendererListeners.delete(listener)
}
/** Null on the server and while hydrating, like the old hydration gate; the module or `'failed'` after. */
const useRenderer = () => useSyncExternalStore(subscribeRenderer, () => rendererModule, () => null)

export function A2uiCard({ card, surfaceKey, render }: A2uiCardProps) {
  const loaded = useRenderer()
  const renderer = loaded === 'failed' ? null : loaded
  // Keyed on the card's CONTENT, not its identity: a parent that re-parses
  // its cards on every render would otherwise rebuild the surface each time,
  // remounting every card in it and resetting the open tab.
  const content = useMemo(() => JSON.stringify(card), [card])
  const surface = useMemo(() => {
    if (!renderer) return null
    const refusal = preflight(surfaceComponents(card), { surface: card.type === 'surface' })
    if (refusal) {
      console.warn('[A2UI] surface refused; drawing the card directly', card.type, refusal)
      return null
    }
    try {
      return renderer.buildSurface(card, surfaceKey)
    } catch (error) {
      console.warn('[A2UI] surface refused; drawing the card directly', card.type, error)
      return null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `content` stands for `card`
  }, [renderer, content, surfaceKey])

  // Reset per surface; set by the first component A2UI draws (`useReportDrawn`).
  const [drawnSurface, setDrawnSurface] = useState<object | null>(null)
  const drawn = surface !== null && drawnSurface === surface
  const reportDrawn = useCallback(() => setDrawnSurface(surface), [surface])
  const refused = loaded !== null && surface === null
  const reportOnScreen = useDrawnReporter()
  // Whether the reader SAW the placeholder: a frame went by with the surface
  // still undrawn. A stored card draws in the layout pass before its first
  // paint, and must not fade in on every thread open; one that took a frame
  // or more to draw replaced a visible placeholder, and fades in over it.
  const drawnNow = useRef(drawn)
  useLayoutEffect(() => {
    drawnNow.current = drawn
  }, [drawn])
  const [placeholderSeen, setPlaceholderSeen] = useState(false)
  useEffect(() => {
    if (!surface || drawn || placeholderSeen) return
    const frame = requestAnimationFrame(() => {
      if (!drawnNow.current) setPlaceholderSeen(true)
    })
    return () => cancelAnimationFrame(frame)
  }, [surface, drawn, placeholderSeen])
  useLayoutEffect(() => {
    if (drawn || refused) reportOnScreen?.()
  }, [drawn, refused, reportOnScreen])

  const direct = <Direct card={card} render={render} />
  const body = (
    <div className="relative">
      {!surface && (refused ? direct : <CardPlaceholder />)}
      {surface && (
        <CardRendererProvider value={render}>
          <DrawnProvider value={reportDrawn}>
            {/* Keyed on the content: a surface that failed once is retried
                when it changes, rather than staying on the fallback for good. */}
            <Fallback key={`${surfaceKey}|${content}`} fallback={direct} onFail={reportOnScreen}>
              {!drawn && <CardPlaceholder />}
              <div
                data-a2ui-surface={surfaceKey}
                data-a2ui-root={card.type}
                aria-hidden={drawn ? undefined : true}
                // Drawn after a placeholder, the surface fades in over where the
                // placeholder stood instead of replacing it in one frame. Not
                // when a `CardSlot` is taking the report (`reportOnScreen`): it
                // cross-fades the whole card itself, and two fades of one card
                // play the entrance twice.
                className={
                  drawn
                    ? reportOnScreen || !placeholderSeen
                      ? undefined
                      : 'animate-in fade-in-0 duration-base ease-entrance motion-reduce:animate-none'
                    : 'pointer-events-none invisible absolute inset-x-0 top-0'
                }
              >
                {renderer && <renderer.A2uiSurface surface={surface} />}
              </div>
            </Fallback>
          </DrawnProvider>
        </CardRendererProvider>
      )}
    </div>
  )
  const title = card.type === 'surface' ? card.title?.trim() : undefined
  if (!title) return body
  return (
    <section className="flex flex-col gap-2" aria-label={title}>
      <p className="card-title text-foreground">{title}</p>
      {body}
    </section>
  )
}
