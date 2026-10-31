/**
 * A page has one canvas, its review (slice 1 of `docs/roadmap/working-on-a-plan.md`):
 * the page action another feature provides (a Skizze on this page) sits in the
 * review's page menu, given the page in view; what it makes is handed to the
 * review to open, and a failure goes to the review's toaster.
 */
import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { I18nProvider } from '@/i18n'
import { PreviewDocumentActionProvider, type ReviewPageActionProps } from '../../preview-actions'
import { ReviewPageMenu } from './review-page-menu'

const toast = vi.hoisted(() => ({ error: vi.fn() }))
vi.mock('sonner', () => ({ toast }))

function FakeAction({ documentId, page, onCreated, onFailed }: ReviewPageActionProps) {
  return (
    <>
      <DropdownMenuItem onSelect={() => onCreated(`sketch-of-${documentId}-${page}`)}>make</DropdownMenuItem>
      <DropdownMenuItem onSelect={() => onFailed('refused')}>fail</DropdownMenuItem>
    </>
  )
}

const open = (onCreated: ((id: string) => void) | null, withAction = true) =>
  render(
    <I18nProvider initialLocale="de" fixedLocale>
      <PreviewDocumentActionProvider action={() => null} pageAction={withAction ? FakeAction : null}>
        <ReviewPageMenu documentId="doc-1" page={4} onCreated={onCreated} />
      </PreviewDocumentActionProvider>
    </I18nProvider>
  )

const openMenu = async () => {
  const trigger = screen.getByTestId('review-page-menu')
  await act(async () => {
    fireEvent.pointerDown(trigger, { button: 0, pointerType: 'mouse' })
  })
}

describe('ReviewPageMenu', () => {
  it('offers the page action for the page in view and hands its result to the review', async () => {
    const onCreated = vi.fn()
    open(onCreated)
    expect(screen.getByTestId('review-page-menu').getAttribute('aria-label')).toBe('Mehr zu Seite 4')
    await openMenu()
    expect(screen.getByText('Seite 4')).toBeTruthy()
    await act(async () => fireEvent.click(screen.getByText('make')))
    expect(onCreated).toHaveBeenCalledWith('sketch-of-doc-1-4')
  })

  it('says a failure in the review’s toaster', async () => {
    open(vi.fn())
    await openMenu()
    await act(async () => fireEvent.click(screen.getByText('fail')))
    expect(toast.error).toHaveBeenCalledWith('refused', expect.any(Object))
  })

  it('is not there without a provided action, or with nowhere to open what it makes', () => {
    const { unmount } = open(vi.fn(), false)
    expect(screen.queryByTestId('review-page-menu')).toBeNull()
    unmount()
    open(null)
    expect(screen.queryByTestId('review-page-menu')).toBeNull()
  })
})
