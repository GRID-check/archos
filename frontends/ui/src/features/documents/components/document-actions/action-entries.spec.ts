/**
 * What a document menu offers — independent of whether it opens from ⋯ or a
 * right-click. The renderer is tested in action-menu.spec; this file pins the
 * heuristics: a viewer who may not mutate sees nothing that mutates, retry is
 * offered wherever it could help (failed, still settling, or stranded at the
 * birth status — the backend refuses a genuinely running job), an indexed file
 * a person uploaded can be re-read, and an empty move submenu is not a submenu.
 */

import { describe, expect, it, vi } from 'vitest'
import {
  cancelOffer,
  documentActionEntries,
  reingestOffer,
  type DocumentActionLabels,
} from './action-entries'

const LABELS: DocumentActionLabels = {
  open: 'Open',
  ask: 'Ask about this',
  select: 'Select',
  download: 'Download',
  rename: 'Rename…',
  move: 'Move to folder',
  copyOriginPath: 'Copy origin path',
  delete: 'Delete…',
  reingest: 'Read again',
  reingesting: 'Retrying…',
  cancel: 'Stop reading',
  cancelling: 'Stopping…',
  allFiles: 'All Files',
}

const DOCUMENT = { id: 'doc-1', filename: 'Einreichplan_EG.pdf', displayName: null }

const handlers = {
  onDownload: vi.fn(),
  onRename: vi.fn(),
  onDelete: vi.fn(),
  onReingest: vi.fn(),
  onCancel: vi.fn(),
  onMove: vi.fn(),
}

function ids(document: Parameters<typeof documentActionEntries>[0]['document'], extra: Partial<Parameters<typeof documentActionEntries>[0]> = {}) {
  return documentActionEntries({
    document,
    labels: LABELS,
    ...handlers,
    ...extra,
  })
    .filter((entry) => entry.type === 'item' || entry.type === 'sub')
    .map((entry) => entry.id)
}

describe('documentActionEntries', () => {
  it('carries download, rename and delete by default, with delete set apart', () => {
    const entries = documentActionEntries({
      document: DOCUMENT,
      labels: LABELS,
      ...handlers,
    })
    const itemIds = entries.filter((e) => e.type === 'item' || e.type === 'sub').map((e) => e.id)
    expect(itemIds).toEqual(['download', 'rename', 'delete'])
    const del = entries.find((e) => e.type === 'item' && e.id === 'delete')
    expect(del?.type === 'item' && del.variant).toBe('destructive')
    expect(entries.some((e) => e.type === 'separator')).toBe(true)
  })

  it('offers only what the surface asked for', () => {
    expect(
      ids(DOCUMENT, { actions: ['rename', 'delete'] }),
    ).toEqual(['rename', 'delete'])
  })

  it('keeps download for a read-only viewer and drops the mutations', () => {
    expect(ids(DOCUMENT, { canManage: false })).toEqual(['download'])
  })

  it('renders nothing at all when a read-only viewer would see an empty menu', () => {
    expect(ids(DOCUMENT, { actions: ['rename', 'delete'], canManage: false })).toEqual([])
  })

  it('offers retry only for a failed document the viewer may manage', () => {
    expect(ids({ ...DOCUMENT, status: 'failed' })).toContain('reingest')
    // No status at all: nothing is known, so nothing is offered.
    expect(ids(DOCUMENT)).not.toContain('reingest')
    expect(ids({ ...DOCUMENT, status: 'failed' }, { canManage: false })).not.toContain('reingest')
  })

  it('offers retry on a still-settling row the backend may have lost', () => {
    // A `processing` row whose job vanished is indistinguishable in the menu
    // from one that is busy; the backend refuses the busy one with 409, so
    // the menu offers everywhere a retry could help.
    expect(ids({ ...DOCUMENT, status: 'processing' })).toContain('reingest')
    expect(ids({ ...DOCUMENT, status: 'pending' })).toContain('reingest')
    expect(ids({ ...DOCUMENT, status: 'uploaded' })).toContain('reingest')
    expect(ids({ ...DOCUMENT, status: 'processing' }, { canManage: false })).not.toContain(
      'reingest'
    )
  })

  it('does not offer it while the bytes are still uploading', () => {
    // The one in-flight row that is certainly busy: there is nothing stored
    // to re-read yet.
    expect(ids({ ...DOCUMENT, status: 'uploading' })).not.toContain('reingest')
    expect(reingestOffer({ status: 'uploading' })).toBeNull()
  })

  it('offers a re-read of an indexed document a person uploaded', () => {
    expect(ids({ ...DOCUMENT, status: 'completed' })).toContain('reingest')
    expect(ids({ ...DOCUMENT, status: 'ready', authoredBy: 'user' })).toContain('reingest')
    expect(reingestOffer({ status: 'completed' })).toBe('reread')
    expect(reingestOffer({ status: 'failed' })).toBe('retry')
    expect(reingestOffer({ status: 'processing' })).toBe('retry')
    expect(ids({ ...DOCUMENT, status: 'completed' }, { canManage: false })).not.toContain('reingest')
  })

  it('keeps agent-authored documents to their own rules', () => {
    // A published agent report is indexed under its published version, which
    // only the publish path may dispatch; a filed draft (`stored`) is never
    // indexed at all.
    expect(ids({ ...DOCUMENT, status: 'completed', authoredBy: 'agent' })).not.toContain('reingest')
    expect(ids({ ...DOCUMENT, status: 'stored', authoredBy: 'agent' })).not.toContain('reingest')
  })

  it('does not offer move when there is nowhere to move it to', () => {
    expect(ids(DOCUMENT)).not.toContain('move')
    expect(ids(DOCUMENT, { folders: [{ id: 'f1', name: 'Brandschutz', parentId: null }] })).toContain(
      'move',
    )
  })

  it('lists the destinations a listing sorted once, in that order, marking where the file is', () => {
    const fireSafety = { id: 'f1', name: 'Brandschutz', parentId: null }
    const fluchtwege = { id: 'f2', name: 'Fluchtwege', parentId: 'f1' }
    const entries = documentActionEntries({
      document: { ...DOCUMENT, folderId: 'f2' },
      labels: LABELS,
      ...handlers,
      destinations: [
        { folder: fireSafety, label: 'Brandschutz' },
        { folder: fluchtwege, label: 'Brandschutz / Fluchtwege' },
      ],
    })
    const move = entries.find((entry) => entry.type === 'sub' && entry.id === 'move')
    expect(move?.type).toBe('sub')
    if (move?.type !== 'sub') return
    expect(move.items.map((item) => (item.type === 'item' ? [item.label, item.disabled] : null))).toEqual([
      ['All Files', false],
      ['Brandschutz', false],
      ['Brandschutz / Fluchtwege', true],
    ])
    expect(ids(DOCUMENT, { destinations: [] })).not.toContain('move')
  })

  it('offers open and ask only when the surface can do them', () => {
    expect(ids(DOCUMENT, { onOpen: vi.fn(), onAsk: vi.fn() })).toEqual([
      'open',
      'ask',
      'download',
      'rename',
      'delete',
    ])
  })

  it('offers copy origin path only when the file has one', () => {
    expect(ids(DOCUMENT, { onCopyOriginPath: vi.fn() })).not.toContain('copy-origin')
    expect(
      ids(
        { ...DOCUMENT, originPath: 'Wohnbau/EG.pdf' },
        { onCopyOriginPath: vi.fn() },
      ),
    ).toContain('copy-origin')
  })
})

describe('cancelOffer — stopping a read', () => {
  it('offers a stop on a row that is being read and has not finished', () => {
    expect(ids({ ...DOCUMENT, status: 'pending' })).toContain('cancel')
    expect(ids({ ...DOCUMENT, status: 'processing' })).toContain('cancel')
    expect(cancelOffer({ status: 'pending' })).toBe(true)
    expect(cancelOffer({ status: 'processing' })).toBe(true)
  })

  it('offers no stop where there is no ingest job to stop', () => {
    // `uploading`: the bytes are still arriving from the browser; the tray's
    // own cancel aborts that transport. A terminal row is already ended.
    expect(cancelOffer({ status: 'uploading' })).toBe(false)
    expect(cancelOffer({ status: 'completed' })).toBe(false)
    expect(cancelOffer({ status: 'failed' })).toBe(false)
    expect(cancelOffer({ status: 'cancelled' })).toBe(false)
    // No status at all: nothing is known, so nothing is offered.
    expect(cancelOffer({})).toBe(false)
  })

  it('offers no stop to someone who may not manage the document', () => {
    expect(ids({ ...DOCUMENT, status: 'processing' }, { canManage: false })).not.toContain('cancel')
  })

  it('hides the stop when the surface did not ask for it', () => {
    expect(ids({ ...DOCUMENT, status: 'processing' }, { actions: ['download'] })).not.toContain(
      'cancel',
    )
  })

  it('runs the surface’s cancel handler from the item', () => {
    const onCancel = vi.fn()
    const entry = documentActionEntries({
      document: { ...DOCUMENT, status: 'processing' },
      labels: LABELS,
      ...handlers,
      onCancel,
    }).find((e) => e.type === 'item' && e.id === 'cancel')
    if (entry?.type !== 'item') throw new Error('no cancel entry')
    expect(entry.label).toBe('Stop reading')
    entry.onSelect?.()
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('says the read is being stopped while the request is in flight', () => {
    const entry = documentActionEntries({
      document: { ...DOCUMENT, status: 'processing' },
      labels: LABELS,
      ...handlers,
      isCancelling: true,
    }).find((e) => e.type === 'item' && e.id === 'cancel')
    if (entry?.type !== 'item') throw new Error('no cancel entry')
    expect(entry.label).toBe('Stopping…')
    expect(entry.disabled).toBe(true)
  })
})

describe('documentActionEntries — picking several, and moving on a phone', () => {
  const folders = [{ id: 'f-1', name: 'Baustelle', parentId: null }]

  it('offers „Auswählen" only to a listing that can select, and only to someone who may manage', () => {
    expect(ids(DOCUMENT)).not.toContain('select')
    expect(ids(DOCUMENT, { onSelect: vi.fn() })).toContain('select')
    expect(ids(DOCUMENT, { onSelect: vi.fn(), canManage: false })).not.toContain('select')
  })

  it('runs the listing’s select handler', () => {
    const onSelect = vi.fn()
    const entry = documentActionEntries({ document: DOCUMENT, labels: LABELS, ...handlers, onSelect }).find(
      (e) => e.type === 'item' && e.id === 'select',
    )
    if (entry?.type !== 'item') throw new Error('no select entry')
    entry.onSelect?.()
    expect(onSelect).toHaveBeenCalledTimes(1)
  })

  it('keeps the move SUBMENU on a desk', () => {
    const entries = documentActionEntries({ document: DOCUMENT, labels: LABELS, ...handlers, folders })
    expect(entries.find((e) => e.type !== 'separator' && e.type !== 'radio-group' && e.id === 'move')?.type).toBe('sub')
  })

  it('makes „Verschieben" one item that opens the folder sheet where a submenu has no room', () => {
    const onPickMoveTarget = vi.fn()
    const entries = documentActionEntries({
      document: DOCUMENT,
      labels: LABELS,
      ...handlers,
      folders,
      onPickMoveTarget,
    })
    const move = entries.find((e) => e.type !== 'separator' && e.type !== 'radio-group' && e.id === 'move')
    expect(move?.type).toBe('item')
    if (move?.type === 'item') move.onSelect?.()
    expect(onPickMoveTarget).toHaveBeenCalledTimes(1)
    expect(handlers.onMove).not.toHaveBeenCalled()
  })

  it('offers no move at all without a folder to move to, sheet or not', () => {
    expect(ids(DOCUMENT, { onPickMoveTarget: vi.fn(), folders: [] })).not.toContain('move')
  })
})
