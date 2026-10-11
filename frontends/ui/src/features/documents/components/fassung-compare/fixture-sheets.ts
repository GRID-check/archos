/**
 * Two drawn sheets for the dev preview and the specs: a floor outline, once as
 * it was and once with a partition wall moved, a door turned and a window
 * added. Drawn in code, so no image file is committed.
 */

import {
  NotComparableError,
  type CompareFile,
  type CompareRegion,
  type PageSize,
  type PageSource,
  type RenderHandle,
  type SourceLoader,
} from './types'

export const FIXTURE_SIZE: PageSize = { width: 840, height: 594 }

type Revision = 'older' | 'newer'

const INK = '#16181d'

function line(ctx: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number, width = 2): void {
  ctx.lineWidth = width
  ctx.beginPath()
  ctx.moveTo(x1, y1)
  ctx.lineTo(x2, y2)
  ctx.stroke()
}

function floorPlan(ctx: CanvasRenderingContext2D, revision: Revision): void {
  // Outer walls.
  ctx.lineWidth = 6
  ctx.strokeRect(80, 70, 680, 400)
  // Corridor spine and the partition that moves between the two revisions.
  line(ctx, 80, 270, 760, 270, 4)
  const partition = revision === 'older' ? 420 : 480
  line(ctx, partition, 70, partition, 270, 4)
  line(ctx, 250, 270, 250, 470, 4)
  line(ctx, 560, 270, 560, 470, 4)
  // A door: leaf and swing. It swings the other way in the newer sheet.
  const doorX = 330
  line(ctx, doorX, 270, doorX, 270 + (revision === 'older' ? 44 : -44), 2)
  ctx.beginPath()
  ctx.lineWidth = 1
  ctx.arc(doorX, 270, 44, revision === 'older' ? 0 : -Math.PI / 2, revision === 'older' ? Math.PI / 2 : 0)
  ctx.stroke()
  // Windows on the north wall; the newer sheet has one more.
  const windows = revision === 'older' ? [160, 300] : [160, 300, 620]
  for (const x of windows) {
    ctx.lineWidth = 2
    ctx.strokeRect(x, 64, 80, 12)
  }
  // Dimension line.
  ctx.lineWidth = 1
  line(ctx, 80, 510, 760, 510, 1)
  line(ctx, 80, 500, 80, 520, 1)
  line(ctx, 760, 500, 760, 520, 1)
  ctx.font = '14px sans-serif'
  ctx.fillText('6 800', 400, 504)
  ctx.font = '12px sans-serif'
  ctx.fillText('Büro 1', 150, 170)
  ctx.fillText(revision === 'older' ? 'Besprechung' : 'Besprechung (größer)', partition + 14, 170)
}

function detailSheet(ctx: CanvasRenderingContext2D, revision: Revision): void {
  // A stair in section: the newer sheet has one more riser.
  const steps = revision === 'older' ? 8 : 9
  ctx.lineWidth = 3
  ctx.beginPath()
  ctx.moveTo(120, 460)
  for (let step = 0; step < steps; step += 1) {
    ctx.lineTo(120 + step * 70, 460 - step * 40)
    ctx.lineTo(190 + step * 70, 460 - step * 40)
  }
  ctx.stroke()
  line(ctx, 80, 470, 760, 470, 4)
  ctx.font = '12px sans-serif'
  ctx.fillText(`Treppe, ${steps} Steigungen`, 120, 120)
}

function titleBlock(ctx: CanvasRenderingContext2D, revision: Revision, page: number): void {
  ctx.lineWidth = 2
  ctx.strokeRect(560, 520, 240, 54)
  ctx.font = '11px sans-serif'
  ctx.fillText('Grundriss 1. OG', 570, 540)
  ctx.fillText(`Index ${revision === 'older' ? 'B' : 'C'}  ·  Blatt ${page}`, 570, 560)
}

/** Paint one fixture sheet into `canvas` at `scale` CSS pixels per unit. */
export function paintFixtureSheet(
  canvas: HTMLCanvasElement,
  revision: Revision,
  page: number,
  scale: number,
  pixelRatio: number,
): void {
  canvas.width = Math.max(1, Math.floor(FIXTURE_SIZE.width * scale * pixelRatio))
  canvas.height = Math.max(1, Math.floor(FIXTURE_SIZE.height * scale * pixelRatio))
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.setTransform(scale * pixelRatio, 0, 0, scale * pixelRatio, 0, 0)
  ctx.strokeStyle = INK
  ctx.fillStyle = INK
  ctx.lineCap = 'square'
  if (page === 1) floorPlan(ctx, revision)
  else detailSheet(ctx, revision)
  titleBlock(ctx, revision, page)
}

export function fixtureSource(revision: Revision, pageCount: number): PageSource {
  return {
    pageCount,
    pageSize: async () => FIXTURE_SIZE,
    render: (page, canvas, { scale, pixelRatio }): RenderHandle => {
      paintFixtureSheet(canvas, revision, page, scale, pixelRatio)
      return { promise: Promise.resolve(), cancel: () => {} }
    },
    destroy: () => {},
  }
}

/**
 * A loader for the preview: the file name picks the story.
 * `*.xlsx` cannot be drawn, `*-kurz*` has one page, `fail*` rejects, anything
 * else is a two-sheet set (the newer one with a third page when named `*-mehr*`).
 */
export const fixtureLoader: SourceLoader = async (file: CompareFile) => {
  const name = file.filename.toLowerCase()
  if (name.endsWith('.xlsx')) throw new NotComparableError()
  if (name.startsWith('fail')) throw new Error('fixture failure')
  const revision: Revision = name.includes('_c') || name.includes('neu') ? 'newer' : 'older'
  const pages = name.includes('-kurz') ? 1 : name.includes('-mehr') ? 3 : 2
  return fixtureSource(revision, pages)
}

/** Sample changes on the fixture's newer sheet, in page-relative coordinates. */
export const FIXTURE_OVERLAYS: readonly CompareRegion[] = [
  { page: 1, x: 0.48, y: 0.1, w: 0.14, h: 0.36, label: 'Trennwand um 60 cm versetzt' },
  { page: 1, x: 0.34, y: 0.42, w: 0.12, h: 0.18, label: 'Türanschlag gedreht' },
  { page: 1, x: 0.72, y: 0.08, w: 0.11, h: 0.06, label: 'Neues Fenster im Norden' },
  { page: 2, x: 0.74, y: 0.18, w: 0.12, h: 0.2, label: 'Zusätzliche Steigung' },
]
