/**
 * „Wer war dabei" in the close dialog: the Steckbrief read from its route,
 * editable before the project locks, and never in the way of closing.
 */
import { render, screen } from '@/test-utils'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { SteckbriefView } from '@/lib/projects/steckbrief-types'
import { ClosingSteckbrief } from './closing-steckbrief'

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }) }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

const VIEW: SteckbriefView = {
  address: null,
  startedOn: '2024-03',
  startedOnIsDefault: false,
  endedOn: null,
  people: [{ id: null, kind: 'member', userId: 'u1', name: 'Andreas Berger', function: null, company: null, startedOn: '2024-03', endedOn: null }],
  rosterKnown: true,
  canEdit: true,
  canErase: true,
}

describe('ClosingSteckbrief', () => {
  afterEach(() => vi.unstubAllGlobals())

  test('shows the period so far and who is on the record, with a way to add someone', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(VIEW)))
    render(<ClosingSteckbrief projectId="p1" />)
    expect(await screen.findByText('Andreas Berger')).toBeInTheDocument()
    expect(screen.getByTestId('closing-steckbrief-period')).toHaveTextContent('since Mar 2024')
    expect(screen.getByRole('button', { name: 'Add person' })).toBeInTheDocument()
  })

  test('says so when it cannot load, and blocks nothing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 500 })))
    render(<ClosingSteckbrief projectId="p1" />)
    expect(await screen.findByText(/could not be loaded. You can still close the project/)).toBeInTheDocument()
  })
})
