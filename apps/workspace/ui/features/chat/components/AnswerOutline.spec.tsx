/**
 * A long answer's section list: offered when there is something to navigate,
 * and a tap goes to the section it names.
 */

import { useRef } from 'react'
import { render, screen, within } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { MarkdownRenderer } from '@/shared/components/MarkdownRenderer'
import { AnswerOutline, MIN_SECTIONS, outlineHeadings } from './AnswerOutline'

const report = (sections: number): string =>
  Array.from({ length: sections }, (_, index) => `## Abschnitt ${index + 1}\n\nText ${index + 1}.\n\n### Unterpunkt ${index + 1}\n\nMehr.`).join('\n\n')

describe('outlineHeadings', () => {
  it('lists sections and sub-sections of a report, in order', () => {
    expect(outlineHeadings(report(MIN_SECTIONS)).map((heading) => heading.text)).toEqual(
      Array.from({ length: MIN_SECTIONS }, (_, index) => [`Abschnitt ${index + 1}`, `Unterpunkt ${index + 1}`]).flat()
    )
  })

  it('offers nothing for a reply too short to need a map', () => {
    expect(outlineHeadings(report(MIN_SECTIONS - 1))).toEqual([])
  })

  it('does not take a heading inside a code fence for a section', () => {
    expect(outlineHeadings('```\n## Eins\n## Zwei\n## Drei\n## Vier\n```')).toEqual([])
  })
})

const Answer = ({ markdown, enabled = true }: { markdown: string; enabled?: boolean }) => {
  const ref = useRef<HTMLDivElement>(null)
  return (
    <AnswerOutline markdown={markdown} scopeRef={ref} enabled={enabled}>
      <div ref={ref}>
        <MarkdownRenderer content={markdown} />
      </div>
    </AnswerOutline>
  )
}

describe('the section list of an answer', () => {
  it('opens as a sheet from the entry row and from a section heading', async () => {
    const user = userEvent.setup()
    render(<Answer markdown={report(5)} />)

    expect(screen.getByTestId('outline-entry')).toHaveTextContent('5 sections')
    await user.click(screen.getByTestId('outline-entry'))
    const sheet = await screen.findByRole('dialog')
    expect(within(sheet).getAllByRole('button', { name: /^(Abschnitt|Unterpunkt) \d$/ })).toHaveLength(10)
    await user.click(within(sheet).getByRole('button', { name: 'Close' }))
    await vi.waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())

    // Every section heading carries the same way in.
    expect(screen.getAllByTestId('outline-heading-button')).toHaveLength(5)
    await user.click(screen.getAllByTestId('outline-heading-button')[2]!)
    expect(await screen.findByRole('dialog')).toBeInTheDocument()
  })

  it('closes and scrolls to the section that was picked, inside this answer', async () => {
    const user = userEvent.setup()
    const scrolled: string[] = []
    const original = Element.prototype.scrollIntoView
    Element.prototype.scrollIntoView = function scrollIntoView(this: Element) {
      scrolled.push(this.id)
    }
    try {
      render(<Answer markdown={report(4)} />)
      await user.click(screen.getByTestId('outline-entry'))
      await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Abschnitt 3' }))

      await vi.waitFor(() => expect(scrolled).toEqual(['abschnitt-3']))
      expect(screen.queryByRole('dialog')).toBeNull()
    } finally {
      Element.prototype.scrollIntoView = original
    }
  })

  it('is absent from a short reply, and from an answer still arriving', () => {
    const { rerender } = render(<Answer markdown={report(MIN_SECTIONS - 1)} />)
    expect(screen.queryByTestId('outline-entry')).toBeNull()
    expect(screen.queryByTestId('outline-heading-button')).toBeNull()

    rerender(<Answer markdown={report(6)} enabled={false} />)
    expect(screen.queryByTestId('outline-entry')).toBeNull()
    expect(screen.queryByTestId('outline-heading-button')).toBeNull()
  })

  it('does not remount the answer when the outline appears at the settle', () => {
    const { rerender } = render(<Answer markdown={report(6)} enabled={false} />)
    const heading = screen.getAllByRole('heading', { level: 2 })[0]!
    rerender(<Answer markdown={report(6)} enabled />)
    expect(screen.getAllByRole('heading', { level: 2 })[0]).toBe(heading)
  })
})
