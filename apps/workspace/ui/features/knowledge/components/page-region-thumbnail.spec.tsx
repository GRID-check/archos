/**
 * The place thumbnail: nothing is fetched until it is on screen, then only the
 * clip around the box is drawn with the box marked; a reader who may not open
 * the document gets a tile and nothing of the page; an image upload is drawn
 * from the signed picture the preview route hands out. pdf.js is a recorder.
 */
import { render, screen, waitFor } from '@/test-utils'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { installLayoutObservers } from '@/test-utils/layout-observers'
import type { PagePlace } from '../lib/page-place'
import { PageRegionThumbnail } from './page-region-thumbnail'

const pdf = vi.hoisted(() => ({
  opened: [] as string[],
  viewports: [] as Array<{ scale: number; offsetX?: number; offsetY?: number }>,
  status: null as number | null,
}))

vi.mock('../lib/pdfjs-runtime', () => ({
  documentParameters: (url: string) => ({ url }),
  loadPdfjs: async () => ({
    getDocument: ({ url }: { url: string }) => {
      pdf.opened.push(url)
      return {
        promise:
          pdf.status !== null
            ? Promise.reject(Object.assign(new Error('Unexpected server response'), { status: pdf.status }))
            : Promise.resolve({
                numPages: 3,
                getPage: async () => ({
                  getViewport: (options: { scale: number; offsetX?: number; offsetY?: number }) => {
                    pdf.viewports.push(options)
                    return { width: 1000 * options.scale, height: 700 * options.scale }
                  },
                  render: () => ({ cancel: () => {}, promise: Promise.resolve() }),
                }),
              }),
        destroy: async () => {},
      }
    },
  }),
}))

const PLACE: PagePlace = {
  document: { id: 'doc-1', name: 'Grundriss EG.pdf', shelf: 'stored' },
  page: 2,
  frame: 'page',
  region: [0.6, 0.05, 0.3, 0.2],
}

let restore: () => void = () => undefined

beforeEach(() => {
  pdf.opened = []
  pdf.viewports = []
  pdf.status = null
})
afterEach(() => {
  restore()
  vi.unstubAllGlobals()
})

describe('PageRegionThumbnail', () => {
  test('waits until it is on screen', async () => {
    render(<PageRegionThumbnail place={PLACE} />)
    // The suite's IntersectionObserver never reports: nothing comes near the screen.
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(pdf.opened).toEqual([])
    expect(document.querySelector('[data-place-thumbnail]')).toHaveAttribute('data-state', 'waiting')
  })

  test('on screen, draws the clip around the box from the document’s own stream and marks the box', async () => {
    restore = installLayoutObservers({ frameWidth: 300 })
    render(<PageRegionThumbnail place={PLACE} label="Grundriss EG.pdf, Seite 2" />)
    await waitFor(() => expect(document.querySelector('[data-place-thumbnail]')).toHaveAttribute('data-state', 'drawn'))
    expect(pdf.opened).toEqual(['/api/documents/doc-1/file'])
    // Only the clip is rasterized: the viewport is shifted to the clip's corner.
    const drawn = pdf.viewports.at(-1)!
    expect(drawn.offsetX).toBeLessThan(0)
    expect(screen.getByRole('img', { name: 'Grundriss EG.pdf, Seite 2' })).toBeInTheDocument()
    const mark = screen.getByTestId('region-mark')
    expect(parseFloat(mark.style.left)).toBeGreaterThan(0)
    expect(parseFloat(mark.style.width)).toBeLessThan(100)
  })

  test('the whole page, with the box still marked, without clip', async () => {
    restore = installLayoutObservers({ frameWidth: 300 })
    render(<PageRegionThumbnail place={PLACE} clip={false} />)
    await waitFor(() => expect(screen.getByTestId('region-mark')).toBeInTheDocument())
    expect(pdf.viewports.at(-1)!.offsetX ?? 0).toBeCloseTo(0, 10)
    expect(parseFloat(screen.getByTestId('region-mark').style.left)).toBeCloseTo(60, 5)
  })

  test('a reader who may not open the document sees a tile, not the page', async () => {
    restore = installLayoutObservers()
    pdf.status = 404
    const onDenied = vi.fn()
    render(<PageRegionThumbnail place={PLACE} onDenied={onDenied} />)
    await waitFor(() => expect(screen.getByText('Not available to you')).toBeInTheDocument())
    expect(screen.queryByTestId('region-mark')).toBeNull()
    expect(screen.queryByRole('img')).toBeNull()
    expect(onDenied).toHaveBeenCalledOnce()
  })

  test('a corpus file is read from the corpus route', async () => {
    restore = installLayoutObservers()
    render(<PageRegionThumbnail place={{ ...PLACE, document: { id: null, name: 'OIB-RL 2.pdf', shelf: 'base' } }} />)
    await waitFor(() => expect(pdf.opened).toEqual(['/api/knowledge-base/documents/OIB-RL%202.pdf']))
  })

  test('an image upload is drawn from the signed picture of its preview', async () => {
    restore = installLayoutObservers({ frameWidth: 300 })
    pdf.status = 415
    const fetchMock = vi.fn(async () =>
      Response.json({ url: 'https://store/photo.jpg?sig', imageUrl: '/api/documents/doc-1/image?sig=1', contentType: 'image/jpeg' })
    )
    vi.stubGlobal('fetch', fetchMock)
    class LoadedImage {
      naturalWidth = 1600
      naturalHeight = 1200
      onload: (() => void) | null = null
      onerror: (() => void) | null = null
      set src(_value: string) {
        queueMicrotask(() => this.onload?.())
      }
    }
    vi.stubGlobal('Image', LoadedImage)
    const onDrawn = vi.fn()
    render(<PageRegionThumbnail place={PLACE} label="Foto" onDrawn={onDrawn} />)
    await waitFor(() => expect(screen.getByRole('img', { name: 'Foto' })).toHaveAttribute('src', '/api/documents/doc-1/image?sig=1'))
    expect(fetchMock).toHaveBeenCalledWith('/api/documents/doc-1/preview', expect.anything())
    expect(screen.getByTestId('region-mark')).toBeInTheDocument()
    expect(onDrawn).toHaveBeenCalledWith({ image: expect.objectContaining({ url: '/api/documents/doc-1/image?sig=1' }) })
  })
})
