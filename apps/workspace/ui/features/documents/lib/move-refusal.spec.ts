/**
 * A move refused because Skizzen traced over the document lie wider than its
 * destination (S6) is read with the Skizzen's names, and offered to move them
 * along only when the server named every one of them.
 */
import { describe, expect, it } from 'vitest'
import { refusalOf, ShelfRequestError, throwUnlessOk } from './move-refusal'

const refused = (details: Record<string, unknown>) => Response.json({ error: 'x', details }, { status: 400 })

describe('throwUnlessOk', () => {
  it('reads the traced Skizzen a refusal names, and that they may move along', async () => {
    const error = await throwUnlessOk(refused({ reason: 'traced_sketches_wider', sketches: [{ id: 'a', name: 'Lageplan, S. 2 — Skizze' }], hidden: 0 })).catch((caught: unknown) => caught)
    expect(refusalOf(error)).toBe('tracedSketches')
    expect((error as ShelfRequestError).traced).toEqual({ names: ['Lageplan, S. 2 — Skizze'], movable: true })
  })

  it('offers no move along when a traced Skizze is one the person may not open', async () => {
    const error = await throwUnlessOk(refused({ reason: 'traced_sketches_wider', sketches: [], hidden: 1 })).catch((caught: unknown) => caught)
    expect((error as ShelfRequestError).traced).toEqual({ names: [], movable: false })
  })

  it('states no reason for an answer that names none', async () => {
    const error = await throwUnlessOk(new Response('oops', { status: 500 })).catch((caught: unknown) => caught)
    expect(refusalOf(error)).toBeNull()
  })
})
