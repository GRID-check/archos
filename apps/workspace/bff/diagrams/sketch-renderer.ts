/**
 * The server draws a Skizze's picture from its scene (ADR-0149).
 *
 * A save sends the scene; this module hands it to Excalidraw's own
 * `exportToSvg` in a worker thread (`sketch-render-worker.ts`, bundled by
 * `scripts/build-sketch-renderer.ts`) and answers the SVG that is filed, so the
 * picture, the PDF drawn from it, the outline and the editor all come from one
 * scene. The worker owns its DOM (happy-dom) and its fonts; the Next server's
 * globals are never touched.
 *
 * Bounds, because a render is CPU on the request path:
 *
 *   - **One worker, one render at a time.** Renders queue; at most
 *     {@link MAX_QUEUED} wait, and one more is refused at once (`busy`, a 503
 *     the editor retries). A steady render takes 15 to 50 ms, so the queue is
 *     about a second of work.
 *   - **A fair share per organization**: one organization holds at most
 *     {@link MAX_QUEUED_PER_ORGANIZATION} of the places (running or waiting),
 *     so one office's burst of saves is refused (`busy`) before it fills the
 *     queue every other office's saves on this server wait in. The
 *     organization is the tenant context's (`tenant-context.ts`).
 *   - **Text to lay out**: at most {@link MAX_REMEASURED_CHARS} characters
 *     laid out again per render, refused before it is queued (`too_much_text`,
 *     a 422): measuring is the part that grows with what a request sends, and
 *     a scene of two thousand 5,000-character texts held the worker for
 *     seconds.
 *   - **A deadline** of {@link RENDER_TIMEOUT_MS} per render: past it the
 *     worker is terminated (a render that does not end is a stuck worker,
 *     whatever it is doing) and the next render starts a fresh one.
 *   - **Memory**: the worker's old generation is capped at
 *     {@link WORKER_HEAP_MB}; an idle worker is ended after
 *     {@link IDLE_MS}, so a server that saw one save does not keep its
 *     ~200 MB (measured: 160 to 210 MB over
 *     the server's own after a 150-element render). Under steady traffic it
 *     never idles, and its caches (glyphs per code point, decoded font
 *     chunks) only grow, so it is also recycled between renders after
 *     {@link RECYCLE_AFTER_RENDERS} renders or once its heap passes
 *     {@link RECYCLE_HEAP_MB}, before the cap fails a save.
 *
 * Observable through the save's `sketch-save` score (`render_ms`,
 * `render_elements`, `remeasured`; outcome `render_failed` with the reason),
 * which `sketch-document.ts` records.
 */

import 'server-only'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { getTenantContext } from '@/lib/db/tenant-context'
import type { SketchRenderRequest, SketchRenderResponse } from './sketch-render-types'

export const MAX_QUEUED = 16
export const MAX_QUEUED_PER_ORGANIZATION = 4
export const MAX_REMEASURED_CHARS = 50_000
export const RECYCLE_AFTER_RENDERS = 500
export const RECYCLE_HEAP_MB = 256
export const RENDER_TIMEOUT_MS = 10_000
export const WORKER_HEAP_MB = 384
export const IDLE_MS = 5 * 60_000

export type SketchRenderFailure = 'busy' | 'timeout' | 'crashed' | 'failed' | 'unavailable' | 'too_much_text'

export class SketchRenderError extends Error {
  constructor(
    readonly reason: SketchRenderFailure,
    detail?: string
  ) {
    super(detail ? `sketch render ${reason}: ${detail}` : `sketch render ${reason}`)
    this.name = 'SketchRenderError'
  }
}

export interface RenderedScene {
  svg: string
  /** The text elements laid out again by the server, whole, to replace the sent ones. */
  remeasured: Record<string, unknown>[]
  /** Wall time of the render, queue included. */
  ms: number
}

export interface SketchRendererOptions {
  /** The bundled worker. Defaults to `dist-sketch-render/` beside the app (`/app/dist-sketch-render` in the image). */
  workerPath?: string
  /** Excalidraw's fonts, staged by `scripts/copy-excalidraw-assets.mjs`. */
  fontsDir?: string
  timeoutMs?: number
  idleMs?: number
  /** Recycle the worker after this many renders (tests). */
  recycleAfter?: number
}

interface Job {
  /** Whose render it is, for the fair share: the organization, or `-` outside a tenant. */
  owner: string
  request: SketchRenderRequest
  resolve: (value: RenderedScene) => void
  reject: (error: unknown) => void
  queuedAt: number
}

export interface SketchRenderer {
  render(input: {
    elements: readonly Record<string, unknown>[]
    appState?: Record<string, unknown>
    remeasure: readonly string[]
    /** Whose render it is; the tenant context's organization when left out. */
    organizationId?: string
  }): Promise<RenderedScene>
  /** End the worker now (tests, shutdown). */
  close(): Promise<void>
}

export function createSketchRenderer(options: SketchRendererOptions = {}): SketchRenderer {
  const workerPath = options.workerPath ?? join(process.cwd(), 'dist-sketch-render', 'sketch-render-worker.mjs')
  const fontsDir = options.fontsDir ?? join(process.cwd(), 'public', 'excalidraw', 'fonts')
  const timeoutMs = options.timeoutMs ?? RENDER_TIMEOUT_MS
  const idleMs = options.idleMs ?? IDLE_MS
  const recycleAfter = options.recycleAfter ?? RECYCLE_AFTER_RENDERS
  const queue: Job[] = []
  let worker: Worker | null = null
  let rendered = 0
  let current: { job: Job; timer: NodeJS.Timeout; on: Worker } | null = null
  let idle: NodeJS.Timeout | null = null
  let nextId = 1

  const stop = () => {
    const ending = worker
    worker = null
    if (ending) void ending.terminate()
  }

  const settle = (outcome: { value?: RenderedScene; error?: unknown }) => {
    if (!current) return
    clearTimeout(current.timer)
    const { job } = current
    current = null
    if (outcome.error !== undefined) job.reject(outcome.error)
    else if (outcome.value) job.resolve(outcome.value)
    pump()
  }

  const start = (): Worker => {
    const started = new Worker(workerPath, { workerData: { fontsDir }, resourceLimits: { maxOldGenerationSizeMb: WORKER_HEAP_MB } })
    started.unref()
    started.on('message', (response: SketchRenderResponse) => {
      if (!current || response.id !== current.job.request.id) return
      if (!response.ok) return settle({ error: new SketchRenderError('failed', response.error) })
      rendered += 1
      // Recycled between renders, never during one: the next render starts a fresh worker.
      if (rendered >= recycleAfter || (response.heapMb ?? 0) > RECYCLE_HEAP_MB) stop()
      settle({ value: { svg: response.svg, remeasured: response.remeasured, ms: Math.round(performance.now() - current.job.queuedAt) } })
    })
    // A worker that ended (crashed, or terminated after a deadline) fails only the render it was running.
    const lost = (detail: string) => {
      if (worker === started) worker = null
      if (current?.on === started) settle({ error: new SketchRenderError('crashed', detail) })
    }
    started.on('error', (error) => lost(error.message))
    started.on('exit', (code) => lost(`exit ${code}`))
    return started
  }

  function pump(): void {
    if (current) return
    const job = queue.shift()
    if (!job) {
      if (idle) clearTimeout(idle)
      idle = setTimeout(stop, idleMs)
      idle.unref()
      return
    }
    if (idle) clearTimeout(idle)
    if (!worker) {
      if (!existsSync(workerPath)) {
        job.reject(new SketchRenderError('unavailable', `no renderer at ${workerPath}`))
        return pump()
      }
      worker = start()
      rendered = 0
    }
    const timer = setTimeout(() => {
      stop()
      settle({ error: new SketchRenderError('timeout', `${timeoutMs} ms`) })
    }, timeoutMs)
    current = { job, timer, on: worker }
    worker.postMessage(job.request)
  }

  return {
    render({ organizationId, ...input }) {
      const chars = remeasuredChars(input.elements, input.remeasure)
      if (chars > MAX_REMEASURED_CHARS) return Promise.reject(new SketchRenderError('too_much_text', `${chars} characters to lay out`))
      if (queue.length >= MAX_QUEUED) return Promise.reject(new SketchRenderError('busy'))
      const owner = organizationId ?? ownerOfContext()
      const held = queue.filter((job) => job.owner === owner).length + (current?.job.owner === owner ? 1 : 0)
      if (held >= MAX_QUEUED_PER_ORGANIZATION) return Promise.reject(new SketchRenderError('busy', 'organization share'))
      return new Promise<RenderedScene>((resolve, reject) => {
        queue.push({ owner, request: { id: nextId++, ...input }, resolve, reject, queuedAt: performance.now() })
        pump()
      })
    },
    async close() {
      if (idle) clearTimeout(idle)
      const ending = worker
      worker = null
      if (ending) await ending.terminate()
    },
  }
}

/** The characters of the texts a render lays out again. */
function remeasuredChars(elements: readonly Record<string, unknown>[], remeasure: readonly string[]): number {
  if (remeasure.length === 0) return 0
  const ids = new Set(remeasure)
  let chars = 0
  for (const element of elements) {
    if (ids.has(String(element.id))) chars += String(element.originalText ?? element.text ?? '').length
  }
  return chars
}

function ownerOfContext(): string {
  const context = getTenantContext()
  return context?.kind === 'tenant' ? context.organizationId : '-'
}

let shared: SketchRenderer | null = null

/** The server's renderer, started on first use. */
export function sketchRenderer(): SketchRenderer {
  shared ??= createSketchRenderer()
  return shared
}
