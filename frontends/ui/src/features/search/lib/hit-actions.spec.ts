import { describe, expect, it, vi } from 'vitest'

import type { ActionMenuEntry } from '@/components/ui/action-menu'
import { documentHitActionEntries, documentHitActions } from './hit-actions'

const labels = { ask: 'Piloti fragen', openCurrent: 'Aktuelle Fassung öffnen', openPoints: 'Offene Punkte' }
const ids = (entries: ActionMenuEntry[]): string[] => entries.flatMap((entry) => (entry.type === 'item' ? [entry.id] : []))

describe('documentHitActions', () => {
  it('offers the ask and the open points for a current document of a project', () => {
    expect(documentHitActions({ shelf: 'project', projectId: 'p1', superseded: false })).toEqual(['ask', 'openPoints'])
  })

  it('offers the current Fassung on a superseded hit', () => {
    expect(documentHitActions({ shelf: 'project', projectId: 'p1', superseded: true })).toEqual(['ask', 'openCurrent', 'openPoints'])
  })

  it('offers no chat for a document of the Büroablage, which has no project chat to start it in', () => {
    expect(documentHitActions({ shelf: 'office_shelf', projectId: null, superseded: true })).toEqual(['openCurrent', 'openPoints'])
  })
})

describe('documentHitActionEntries', () => {
  it('wires each entry to its handler, in the menu order, with its label', () => {
    const handlers = { onAsk: vi.fn(), onOpenCurrent: vi.fn(), onOpenPoints: vi.fn() }
    const entries = documentHitActionEntries({ id: 'd1', shelf: 'project', projectId: 'p1', superseded: true }, labels, handlers)
    expect(ids(entries)).toEqual(['ask', 'openCurrent', 'openPoints'])
    for (const entry of entries) if (entry.type === 'item') entry.onSelect?.()
    expect(handlers.onAsk).toHaveBeenCalledOnce()
    expect(handlers.onOpenCurrent).toHaveBeenCalledOnce()
    expect(handlers.onOpenPoints).toHaveBeenCalledOnce()
    expect(entries[1]).toMatchObject({ label: 'Aktuelle Fassung öffnen', testId: 'search-hit-action-openCurrent' })
  })
})
