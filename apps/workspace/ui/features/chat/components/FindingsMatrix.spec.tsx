import { render, screen } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { describe, expect, test, vi } from 'vitest'
import { chatCopy } from '@/i18n/namespaces/chat'
import type { Findings } from '@/lib/conversations/message-findings'
import { FindingsMatrix } from './FindingsMatrix'
import { CurrentProjectProvider } from '@/features/projects/lib/current-project'

const findings: Findings = {
  v: 1,
  items: [
    {
      requirement: 'Feuerwiderstand tragender Bauteile',
      value: 'REI 60',
      status: 'met',
      grounding: 'sourced',
      reference: { document: 'OIB-Richtlinie 2', section: 'Tabelle 1b', page: 12 },
      citations: [1],
      comment: 'Gilt für GK 4; im Kellergeschoß REI 90.',
    },
    { requirement: 'Zweiter Fluchtweg', status: 'open', grounding: 'open', citations: [] },
  ],
}

describe('FindingsMatrix', () => {
  test('one row per finding, the status in words and the count line in numbers', () => {
    render(<FindingsMatrix findings={findings} anchorPrefix="src-" />)
    expect(screen.getAllByTestId('finding-row')).toHaveLength(2)
    expect(screen.getByText(chatCopy.messages.en.findings.status.met)).toBeInTheDocument()
    expect(screen.getByText(chatCopy.messages.en.findings.status.open)).toBeInTheDocument()
    expect(
      screen.getByText(`1 ${chatCopy.messages.en.findings.status.met} · 1 ${chatCopy.messages.en.findings.status.open}`)
    ).toBeInTheDocument()
    expect(screen.getByText('REI 60')).toBeInTheDocument()
  })

  test('a table of rows without verdicts is headed Results, with no status column', () => {
    const results: Findings = {
      v: 1,
      items: [
        { requirement: 'Variante A', value: '12 m', grounding: 'sourced', citations: [1] },
        { requirement: 'Variante B', value: '15 m', grounding: 'sourced', citations: [2] },
      ],
    }
    render(<FindingsMatrix findings={results} anchorPrefix="src-" />)
    expect(screen.getByTestId('findings-matrix')).toHaveAttribute('data-judged', 'false')
    expect(screen.getByText(chatCopy.messages.en.findings.labelResults)).toBeInTheDocument()
    expect(screen.queryByText(chatCopy.messages.en.findings.columns.status)).not.toBeInTheDocument()
    expect(screen.getByText(chatCopy.messages.en.findings.columns.note)).toBeInTheDocument()
    expect(screen.queryByText(chatCopy.messages.en.findings.status.open)).not.toBeInTheDocument()
  })

  test('the [N] jumps to the answer’s own sources row', () => {
    render(<FindingsMatrix findings={findings} anchorPrefix="src-" />)
    expect(screen.getByText('[1]').closest('a')).toHaveAttribute('href', '#src-1')
  })

  test('a row with a comment opens on click; a row without one does not', async () => {
    render(<FindingsMatrix findings={findings} anchorPrefix="src-" />)
    expect(screen.queryByTestId('finding-detail')).not.toBeInTheDocument()
    await userEvent.setup().click(screen.getAllByTestId('finding-row')[0]!)
    expect(screen.getByText('Gilt für GK 4; im Kellergeschoß REI 90.')).toBeInTheDocument()
    await userEvent.setup().click(screen.getAllByTestId('finding-row')[1]!)
    expect(screen.getAllByTestId('finding-detail')).toHaveLength(1)
  })

  test('marks what changed against the previous report and names what was dropped', () => {
    const previous: Findings = {
      v: 1,
      items: [
        {
          requirement: 'Feuerwiderstand tragender Bauteile',
          value: 'REI 90',
          status: 'met',
          grounding: 'sourced',
          citations: [],
        },
        { requirement: 'Barrierefreiheit', status: 'met', grounding: 'sourced', citations: [] },
      ],
    }
    render(<FindingsMatrix findings={findings} previous={previous} />)
    const marks = screen.getAllByTestId('finding-change').map((chip) => chip.textContent)
    expect(marks).toEqual([chatCopy.messages.en.findings.change.changed, chatCopy.messages.en.findings.change.new])
    expect(screen.getByTestId('findings-dropped')).toHaveTextContent('Barrierefreiheit')
  })

  test('in a closed project says, under the matrix, that open findings get no new research (ADR-0090)', () => {
    render(
      <CurrentProjectProvider value={{ id: 'p1', name: 'Seestadt', status: 'closed' as const, closedAt: '2026-10-01T00:00:00Z', readsBecauseClosed: false }}>
        <FindingsMatrix findings={findings} />
      </CurrentProjectProvider>
    )
    expect(screen.getByTestId('findings-closed-project')).toHaveTextContent(chatCopy.messages.en.findings.clarifyClosed)
    expect(screen.queryByTestId('finding-commission')).not.toBeInTheDocument()
  })

  test('an open finding offers „Klären" and shows the receipt once the run is commissioned', async () => {
    const onCommission = vi.fn().mockResolvedValue(true)
    render(<FindingsMatrix findings={findings} onCommission={onCommission} />)
    expect(screen.getAllByTestId('finding-commission')).toHaveLength(1)
    await userEvent.setup().click(screen.getByTestId('finding-commission'))
    expect(onCommission).toHaveBeenCalledWith(
      expect.objectContaining({ requirement: 'Zweiter Fluchtweg' })
    )
    expect(await screen.findByTestId('finding-commissioned')).toBeInTheDocument()
    expect(screen.queryByTestId('finding-commission')).not.toBeInTheDocument()
  })

  test('an unsourced finding says so beside its status', () => {
    render(<FindingsMatrix findings={findings} />)
    expect(screen.getByText(chatCopy.messages.en.findings.grounding.open)).toBeInTheDocument()
  })

  test('a row with a comment is opened by a real control, reachable by keyboard', async () => {
    const user = userEvent.setup()
    render(<FindingsMatrix findings={findings} anchorPrefix="src-" />)
    const toggle = screen.getByRole('button', { name: /Feuerwiderstand tragender Bauteile/ })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')

    toggle.focus()
    await user.keyboard('{Enter}')
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByTestId('finding-detail')).toBeInTheDocument()
    await user.keyboard('{Enter}')
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
  })

  test('names every column on the cell, which is what the stacked phone card reads as its label', () => {
    render(<FindingsMatrix findings={findings} anchorPrefix="src-" />)
    const [row] = screen.getAllByTestId('finding-row')
    const labels = Array.from(row!.querySelectorAll('td[data-label]')).map((cell) => cell.getAttribute('data-label'))
    expect(labels).toEqual([chatCopy.messages.en.findings.columns.value, chatCopy.messages.en.findings.columns.reference])
  })

  test('stacks below 30rem of its own container, in one DOM with the table', () => {
    // jsdom has no container queries: what is held here is that the table and the
    // card are the SAME elements (one set of rows, one click, one test), and that
    // the stacked form is keyed to the matrix's own width rather than the viewport.
    render(<FindingsMatrix findings={findings} anchorPrefix="src-" />)
    expect(screen.getByTestId('findings-matrix').className).toMatch(/@container\/matrix/)
    expect(screen.getByRole('table').className).toMatch(/@max-\[30rem\]\/matrix:block/)
    for (const row of screen.getAllByTestId('finding-row')) {
      expect(row.className).toMatch(/@max-\[30rem\]\/matrix:flex-col/)
    }
  })
})
