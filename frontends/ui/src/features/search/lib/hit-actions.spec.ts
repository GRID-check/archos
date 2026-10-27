import { describe, expect, it, vi } from 'vitest'

import type { ActionMenuEntry } from '@/components/ui/action-menu'
import { documentHitActionEntries, documentHitActions } from './hit-actions'

const labels = {
  open: 'Öffnen',
  ask: 'Piloti fragen',
  openCurrent: 'Aktuelle Fassung öffnen',
  openPoints: 'Offene Punkte',
  showInFolder: 'Im Ordner zeigen',
  copyLink: 'Link kopieren',
}
const ids = (entries: ActionMenuEntry[]): string[] => entries.flatMap((entry) => (entry.type === 'item' ? [entry.id] : ['|']))

describe('documentHitActions', () => {
  it('offers open, ask, the open points, the folder and the link for a current document of a project', () => {
    expect(documentHitActions({ shelf: 'project', projectId: 'p1', superseded: false })).toEqual(['open', 'ask', 'openPoints', 'showInFolder', 'copyLink'])
  })

  it('offers the current Fassung on a superseded hit', () => {
    expect(documentHitActions({ shelf: 'project', projectId: 'p1', superseded: true })).toContain('openCurrent')
  })

  it('offers no chat for a document of the Büroablage, which has no project chat to start it in', () => {
    expect(documentHitActions({ shelf: 'office_shelf', projectId: null, superseded: true })).toEqual([
      'open',
      'openCurrent',
      'openPoints',
      'showInFolder',
      'copyLink',
    ])
  })
})

describe('documentHitActionEntries', () => {
  it('wires each entry to its handler, grouped as the Dateien menu is, with its label', () => {
    const handlers = {
      onOpen: vi.fn(),
      onAsk: vi.fn(),
      onOpenCurrent: vi.fn(),
      onOpenPoints: vi.fn(),
      onShowInFolder: vi.fn(),
      onCopyLink: vi.fn(),
    }
    const entries = documentHitActionEntries({ id: 'd1', shelf: 'project', projectId: 'p1', superseded: true }, labels, handlers)
    expect(ids(entries)).toEqual(['open', 'ask', '|', 'openCurrent', 'openPoints', 'showInFolder', '|', 'copyLink'])
    for (const entry of entries) if (entry.type === 'item') entry.onSelect?.()
    for (const handler of Object.values(handlers)) expect(handler).toHaveBeenCalledOnce()
    expect(entries.find((entry) => entry.type === 'item' && entry.id === 'openCurrent')).toMatchObject({
      label: 'Aktuelle Fassung öffnen',
      testId: 'search-hit-action-openCurrent',
    })
  })
})
