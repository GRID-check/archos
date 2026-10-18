import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { captureDownloads } from '@/test-utils/downloads'
import { downloadFetched, fileNameFromDisposition, startBrowserDownload } from './browser-download'

describe('startBrowserDownload', () => {
  afterEach(() => {
    document.body.replaceChildren()
  })

  test('clicks a temporary attachment link and leaves the page in place', () => {
    const click = vi.fn()
    const created: HTMLAnchorElement[] = []
    const original = document.createElement.bind(document)
    vi.spyOn(document, 'createElement').mockImplementation((tagName: string) => {
      const element = original(tagName)
      if (tagName === 'a') {
        created.push(element as HTMLAnchorElement)
        element.click = click
      }
      return element
    })

    startBrowserDownload('https://files.example/plan.pdf?sig=1', 'Einreichplan.pdf')

    expect(created).toHaveLength(1)
    expect(created[0].href).toBe('https://files.example/plan.pdf?sig=1')
    expect(created[0].download).toBe('Einreichplan.pdf')
    expect(created[0].target).toBe('_blank')
    expect(click).toHaveBeenCalledTimes(1)
    expect(document.body.contains(created[0])).toBe(false)
  })

  test('does nothing with an empty url', () => {
    startBrowserDownload('')
    expect(document.body.childElementCount).toBe(0)
  })
})

describe('fileNameFromDisposition', () => {
  test('reads the UTF-8 name first, then the ASCII one, then the fallback', () => {
    const utf8 = `attachment; filename="x.pdf"; filename*=UTF-8''${encodeURIComponent('Anmerkungen – Fassung 3.pdf')}`
    expect(fileNameFromDisposition(utf8, 'f.pdf')).toBe('Anmerkungen – Fassung 3.pdf')
    expect(fileNameFromDisposition('attachment; filename="Frage.docx"', 'f.docx')).toBe('Frage.docx')
    expect(fileNameFromDisposition("attachment; filename*=UTF-8''%E0%A4%A", 'f.md')).toBe('f.md')
    expect(fileNameFromDisposition(null, 'f.md')).toBe('f.md')
  })
})

describe('downloadFetched', () => {
  // The link-clicking spec above stubs `createElement` for its own test.
  beforeEach(() => vi.restoreAllMocks())
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  test('saves what the route answered under the name it gave', async () => {
    const downloads = captureDownloads()
    Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:file'), revokeObjectURL: vi.fn() })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(new Blob(['x']), { headers: { 'Content-Disposition': 'attachment; filename="a.pdf"' } }))
    )

    await expect(downloadFetched('/api/x', 'fallback.pdf')).resolves.toEqual({ saved: true })
    expect(downloads).toEqual([{ href: 'blob:file', download: 'a.pdf' }])
  })

  test('hands a refusal back with its status and reason, and saves nothing', async () => {
    const downloads = captureDownloads()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ details: { reason: 'too-many-marks' } }, { status: 422 }))
    )
    await expect(downloadFetched('/api/x', 'f.pdf')).resolves.toEqual({ saved: false, status: 422, reason: 'too-many-marks' })

    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new Error('offline'))))
    await expect(downloadFetched('/api/x', 'f.pdf')).resolves.toEqual({ saved: false, status: null, reason: null })
    expect(downloads).toEqual([])
  })
})
