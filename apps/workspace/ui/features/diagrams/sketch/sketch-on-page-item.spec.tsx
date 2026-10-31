/**
 * „Skizze auf dieser Seite beginnen“ (S6, slice 1): the review's page menu item
 * makes the Skizze on the document's current Fassung through the one route
 * (`document-sketch-from-page`) and hands its id back for the review to open;
 * a refusal is named, not only „failed“.
 */
import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { I18nProvider } from '@/i18n'
import { SketchOnPageItem } from './sketch-on-page-item'

const client = vi.hoisted(() => ({
  currentVersionOf: vi.fn(),
  createSketchFromPage: vi.fn(),
}))
vi.mock('@/adapters/api/diagrams-client', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  currentVersionOf: client.currentVersionOf,
  createSketchFromPage: client.createSketchFromPage,
}))
const { SketchRequestError } = await import('@/adapters/api/diagrams-client')

const menu = (props: { onCreated: (id: string) => void; onFailed: (message: string) => void }) =>
  render(
    <I18nProvider initialLocale="de" fixedLocale>
      <DropdownMenu open>
        <DropdownMenuTrigger>menu</DropdownMenuTrigger>
        <DropdownMenuContent>
          <SketchOnPageItem documentId="doc-pdf" page={3} {...props} />
        </DropdownMenuContent>
      </DropdownMenu>
    </I18nProvider>
  )

beforeEach(() => {
  client.currentVersionOf.mockReset().mockResolvedValue('ver-2')
  client.createSketchFromPage.mockReset().mockResolvedValue({ documentId: 'sketch-9' })
})

describe('SketchOnPageItem', () => {
  it('makes the Skizze on the page of the current Fassung and hands it to the review', async () => {
    const onCreated = vi.fn()
    menu({ onCreated, onFailed: vi.fn() })
    expect(screen.getByTestId('sketch-on-page').textContent).toContain('Skizze auf dieser Seite beginnen')
    await act(async () => fireEvent.click(screen.getByTestId('sketch-on-page')))
    expect(client.createSketchFromPage).toHaveBeenCalledWith('doc-pdf', 'ver-2', 3)
    expect(onCreated).toHaveBeenCalledWith('sketch-9')
  })

  it('names a refusal it knows', async () => {
    client.createSketchFromPage.mockRejectedValue(new SketchRequestError(409, null, 'underlay_held'))
    const onFailed = vi.fn()
    const onCreated = vi.fn()
    menu({ onCreated, onFailed })
    await act(async () => fireEvent.click(screen.getByTestId('sketch-on-page')))
    expect(onCreated).not.toHaveBeenCalled()
    expect(onFailed).toHaveBeenCalledWith(expect.stringContaining('Upload-Prüfung'))
  })
})
