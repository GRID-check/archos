import { describe, expect, test, vi } from 'vitest'
import { render, screen, within } from '@/test-utils'
import { pilotiActivityFixture } from '@/app/dev/_fixtures/piloti-activity'
import type { PilotiActivityFetcher } from '@/features/piloti-activity/hooks/use-piloti-activity'
import { PilotiTile } from './live-tiles'

const NOW = new Date('2026-10-13T12:00:00Z')
const HREF = '/app/projects/p1/settings/piloti'

const serving = (response: ReturnType<typeof pilotiActivityFixture>) =>
  vi.fn<PilotiActivityFetcher>().mockResolvedValue(response)

describe('PilotiTile', () => {
  test('counts what runs and what waits, names the first running row and opens the section', async () => {
    render(
      <PilotiTile
        projectId="p1"
        href={HREF}
        fetcher={serving(pilotiActivityFixture('full', NOW))}
      />
    )

    const tile = screen.getByTestId('overview-piloti')
    expect(await within(tile).findByText('5 running now')).toBeInTheDocument()
    // Three proposals and six proposed marks wait.
    expect(within(tile).getByText('9 waiting for a decision')).toBeInTheDocument()
    expect(within(tile).getByText('Now: Annotation 4 · Einreichplan_GR_EG.pdf')).toBeInTheDocument()
    expect(within(tile).getByRole('link', { name: /View/ })).toHaveAttribute('href', HREF)
  })

  test('says nothing runs and nothing waits when that is true, with no row to name', async () => {
    render(
      <PilotiTile
        projectId="p1"
        href={HREF}
        fetcher={serving(pilotiActivityFixture('empty', NOW))}
      />
    )

    const tile = screen.getByTestId('overview-piloti')
    expect(await within(tile).findByText('Nothing running right now')).toBeInTheDocument()
    expect(within(tile).getByText('Nothing is waiting')).toBeInTheDocument()
    expect(within(tile).queryByText(/^Now:/)).not.toBeInTheDocument()
  })

  test('a cut-off section claims no total', async () => {
    const full = pilotiActivityFixture('full', NOW)
    const response = { ...full, running: { ...full.running, truncated: true } }
    render(<PilotiTile projectId="p1" href={HREF} fetcher={serving(response)} />)

    const tile = screen.getByTestId('overview-piloti')
    expect(await within(tile).findByText('and more')).toBeInTheDocument()
    expect(within(tile).getAllByText('and more')).toHaveLength(1)
  })

  test('names a run by its title', async () => {
    const full = pilotiActivityFixture('full', NOW)
    const run = full.running.items.find((item) => item.kind === 'run')
    if (!run) throw new Error('fixture has no run')
    const response = { ...full, running: { ...full.running, items: [run] } }
    render(<PilotiTile projectId="p1" href={HREF} fetcher={serving(response)} />)

    expect(await screen.findByText('Now: Einreichcheck vor Abgabe')).toBeInTheDocument()
    expect(screen.getByText('1 running now')).toBeInTheDocument()
  })

  test('says it could not be loaded when the read fails, and still opens the section', async () => {
    const fetcher = vi.fn<PilotiActivityFetcher>().mockRejectedValue(new Error('503'))
    render(<PilotiTile projectId="p1" href={HREF} fetcher={fetcher} />)

    const tile = screen.getByTestId('overview-piloti')
    expect(await within(tile).findByText('This could not be loaded.')).toBeInTheDocument()
    expect(within(tile).getByRole('link', { name: /View/ })).toHaveAttribute('href', HREF)
  })
})
