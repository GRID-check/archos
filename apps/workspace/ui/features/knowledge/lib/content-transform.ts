/**
 * The one writer of the page stack's `transform` while it zooms.
 *
 * A zoom has two halves and they are kept apart on purpose:
 *
 *  - the LIVE half, while fingers (or a trackpad) are moving: the stack is
 *    scaled on the compositor with a CSS transform, so a pinch runs at the
 *    display's frame rate and nothing is laid out, re-rasterised or re-styled
 *    per frame. An A1 drawing's text layer is thousands of spans; resizing them
 *    sixty times a second is what made the old pinch stutter;
 *  - the COMMIT, once the gesture ends: the zoom becomes layout (the pages'
 *    real width), the transform comes off, and the scroll position is set so
 *    the point under the fingers stays put. If the layout cannot show exactly
 *    what the transform showed (the zoom was held past an end, or the scroll
 *    hit an edge), the difference is played out as a short settle from the
 *    shown state to the laid-out one: a FLIP, transform-only.
 *
 * The gesture hook writes the live half and the viewer the commit; both go
 * through this object, so neither can leave a transition or a `will-change`
 * behind for the other to trip over.
 */

export interface StackTransform {
  x: number
  y: number
  scale: number
}

const IDENTITY: StackTransform = { x: 0, y: 0, scale: 1 }

/** Below this, a settle is not worth playing: half a pixel, a thousandth of scale. */
const NEGLIGIBLE_SHIFT = 0.5
const NEGLIGIBLE_SCALE = 1e-3

/** How long a settle may take before it is finished by force (the token is 240ms). */
const SETTLE_FALLBACK_MS = 400

export const isNegligible = (transform: StackTransform): boolean =>
  Math.abs(transform.x) < NEGLIGIBLE_SHIFT &&
  Math.abs(transform.y) < NEGLIGIBLE_SHIFT &&
  Math.abs(transform.scale - 1) < NEGLIGIBLE_SCALE

export const transformCss = (transform: StackTransform): string =>
  `translate3d(${transform.x}px, ${transform.y}px, 0) scale(${transform.scale})`

export class ContentTransform {
  private node: HTMLElement | null = null
  private settling: { timer: number; done: () => void } | null = null
  private live = false
  private readonly listeners = new Set<() => void>()

  attach(node: HTMLElement | null): void {
    if (this.node === node) return
    this.finish()
    this.node = node
  }

  /** Whether the stack is drawn somewhere other than where it is laid out. */
  get active(): boolean {
    return this.live || this.settling !== null
  }

  /** Told whenever the stack comes back to rest: a good moment to draw details. */
  onRest(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Show the stack transformed, now, without a transition: a gesture frame. */
  preview(transform: StackTransform): void {
    const node = this.node
    if (!node) return
    this.finish()
    this.live = true
    node.style.transformOrigin = '0 0'
    node.style.willChange = 'transform'
    node.style.transition = 'none'
    node.style.transform = transformCss(transform)
  }

  /** Take the transform off at once: the commit's first step. */
  clear(): void {
    const node = this.node
    this.finish()
    this.live = false
    if (!node) return
    node.style.transform = ''
    node.style.transition = ''
    node.style.willChange = ''
  }

  /**
   * Play from `from` back to the laid-out stack: the FLIP's last step. With
   * reduced motion, or when there is nothing to see, it simply clears.
   */
  settle(from: StackTransform, options: { animate: boolean }): void {
    const node = this.node
    this.clear()
    if (!node || isNegligible(from) || !options.animate) {
      this.rest()
      return
    }
    node.style.transformOrigin = '0 0'
    node.style.willChange = 'transform'
    node.style.transition = 'none'
    node.style.transform = transformCss(from)
    // Read layout once so the starting transform is committed before the
    // transition is set; without it the browser coalesces both writes and
    // there is nothing to animate from.
    void node.offsetWidth
    node.style.transition = 'transform var(--motion-base) var(--ease-entrance)'
    node.style.transform = transformCss(IDENTITY)
    const done = (): void => {
      node.removeEventListener('transitionend', onEnd)
      if (!this.settling) return
      window.clearTimeout(this.settling.timer)
      this.settling = null
      node.style.transition = ''
      node.style.transform = ''
      node.style.willChange = ''
      this.rest()
    }
    const onEnd = (event: TransitionEvent): void => {
      if (event.target === node && event.propertyName === 'transform') done()
    }
    node.addEventListener('transitionend', onEnd)
    this.settling = { timer: window.setTimeout(done, SETTLE_FALLBACK_MS), done }
  }

  /** End a settle in progress at its end state: a new gesture takes over from rest. */
  finish(): void {
    const settling = this.settling
    if (settling) settling.done()
  }

  /** The gesture is over and nothing needs settling. */
  release(): void {
    if (!this.live) return
    this.clear()
    this.rest()
  }

  private rest(): void {
    this.live = false
    for (const listener of this.listeners) listener()
  }
}
