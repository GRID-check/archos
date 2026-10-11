import { describe, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'

vi.mock('@/adapters/api/upload-screening-policy', async () => {
  const { SUGGESTED_SCREENING_POLICY } = await import('@/lib/upload-screening/policy')
  return { loadUploadScreeningPolicy: vi.fn().mockResolvedValue(SUGGESTED_SCREENING_POLICY) }
})
vi.mock('../lib/content-digest', () => ({ digestFiles: vi.fn().mockResolvedValue(new Map()) }))

import { useUploadDecision } from './use-upload-decision'

function pathed(relativePath: string): File {
  const file = new File(['x'], relativePath.split('/').pop()!, { type: 'application/pdf' })
  Object.defineProperty(file, 'webkitRelativePath', { value: relativePath, configurable: true })
  return file
}

/**
 * ADR-0086: the decision hook plans every durable-shelf upload against the
 * office's screening, so what the policy names opens the dialog instead of
 * going straight out, and a release re-plans without re-reading anything.
 */
describe('useUploadDecision — upload screening', () => {
  it('opens the dialog for a loose file the policy names, instead of sending it', async () => {
    const sendDirect = vi.fn()
    const { result } = renderHook(() => useUploadDecision())
    const invoice = new File(['x'], 'Rechnung 12.pdf')

    await act(async () => {
      await result.current.propose({ files: [invoice], documents: [], folders: [], currentFolderId: null }, sendDirect)
    })

    expect(sendDirect).not.toHaveBeenCalled()
    await waitFor(() => expect(result.current.plan?.files[0]?.action).toBe('excluded'))
    expect(result.current.open).toBe(true)
  })

  it('sends a clean loose file straight out, as before', async () => {
    const sendDirect = vi.fn()
    const { result } = renderHook(() => useUploadDecision())
    const plan = new File(['x'], 'Grundriss.pdf')

    await act(async () => {
      await result.current.propose({ files: [plan], documents: [], folders: [], currentFolderId: null }, sendDirect)
    })

    expect(sendDirect).toHaveBeenCalledWith([plan])
  })

  it('re-plans a released file as what it would otherwise be', async () => {
    const { result } = renderHook(() => useUploadDecision())
    const contract = pathed('Akt/Verträge/Architektenvertrag.pdf')

    await act(async () => {
      await result.current.propose({ files: [contract], documents: [], folders: [], currentFolderId: null }, vi.fn())
    })
    await waitFor(() => expect(result.current.plan?.files[0]?.action).toBe('excluded'))
    expect(result.current.plan?.folders).toEqual([])

    await act(async () => {
      await result.current.setReleased(contract, true)
    })
    expect(result.current.plan?.files[0]).toMatchObject({ action: 'new', screeningReleased: true })
    expect(result.current.plan?.folders.map((folder) => folder.path)).toEqual(['Akt', 'Akt/Verträge'])

    await act(async () => {
      await result.current.setReleased(contract, false)
    })
    expect(result.current.plan?.files[0]?.action).toBe('excluded')
  })

  it('screens against the folder the reader stands in', async () => {
    const { result } = renderHook(() => useUploadDecision())
    await act(async () => {
      await result.current.propose(
        { files: [new File(['x'], '0042.pdf')], documents: [], folders: [], currentFolderId: 'f1', screeningBasePath: 'Lohnzettel' },
        vi.fn()
      )
    })
    await waitFor(() => expect(result.current.plan?.files[0]?.action).toBe('excluded'))
  })
})

describe('useUploadDecision — what the operating system left in the folder', () => {
  it('plans a dropped folder without .DS_Store, Thumbs.db or an Office lock file', async () => {
    const { result } = renderHook(() => useUploadDecision())
    const files = [
      pathed('Wohnbau Nord/EG.pdf'),
      pathed('Wohnbau Nord/.DS_Store'),
      pathed('Wohnbau Nord/Thumbs.db'),
      pathed('Wohnbau Nord/~$Baubeschreibung.docx'),
    ]

    await act(async () => {
      await result.current.propose({ files, documents: [], folders: [], currentFolderId: null }, vi.fn())
    })

    await waitFor(() => expect(result.current.plan?.files.map((entry) => entry.file.name)).toEqual(['EG.pdf']))
  })

  it('does nothing for a drop that held only such files', async () => {
    const sendDirect = vi.fn()
    const { result } = renderHook(() => useUploadDecision())

    await act(async () => {
      await result.current.propose(
        { files: [new File(['x'], '.DS_Store')], documents: [], folders: [], currentFolderId: null },
        sendDirect
      )
    })

    expect(sendDirect).not.toHaveBeenCalled()
    expect(result.current.open).toBe(false)
  })
})

/**
 * ADR-0099: a name that continues a document already on the shelf is a reason
 * to ask, even when nothing of that name exists, and the reader's answers
 * re-plan like a release does.
 */
describe('useUploadDecision — Fassungen across names', () => {
  const answer = (name: string, ids = ['b']) => ({
    name,
    candidates: ids.map((id) => ({ id, filename: `${id}.pdf`, displayName: null, label: `Index ${id.toUpperCase()}` })),
    newer: true,
    unambiguous: ids.length === 1,
  })
  const base = { documents: [] as never[], folders: [], currentFolderId: null }

  it('opens the dialog for a loose new file that continues a document, with the offer ticked', async () => {
    const sendDirect = vi.fn()
    const offers = vi.fn(async (names: readonly string[]) => names.map((name) => answer(name)))
    const { result } = renderHook(() => useUploadDecision())
    const file = new File(['x'], 'EG_Grundriss_Index_C.pdf')

    await act(async () => {
      await result.current.propose({ ...base, files: [file], fassungOffers: offers }, sendDirect)
    })

    expect(sendDirect).not.toHaveBeenCalled()
    expect(offers).toHaveBeenCalledWith(['EG_Grundriss_Index_C.pdf'], new Map([['EG_Grundriss_Index_C.pdf', null]]))
    await waitFor(() => expect(result.current.plan?.files[0].fassungOf).toMatchObject({ chosen: true, of: { id: 'b' } }))
    expect(result.current.open).toBe(true)
  })

  it('sends a file straight out when nothing is continued, and asks only about names that read as a series', async () => {
    const sendDirect = vi.fn()
    const offers = vi.fn(async () => [])
    const { result } = renderHook(() => useUploadDecision())
    const files = [new File(['x'], 'Baubeschreibung.pdf'), new File(['x'], 'EG_Grundriss_Index_C.pdf')]

    await act(async () => {
      await result.current.propose({ ...base, files, fassungOffers: offers }, sendDirect)
    })

    expect(offers).toHaveBeenCalledWith(['EG_Grundriss_Index_C.pdf'], expect.any(Map))
    expect(sendDirect).toHaveBeenCalledWith(files)
  })

  it('says where each name lands: the existing folder, or the nearest existing one above a folder still to be created (ADR-0087)', async () => {
    const offers = vi.fn(async () => [])
    const { result } = renderHook(() => useUploadDecision())
    const folders = [
      { id: 'f-root', parentId: null, name: 'Projekt', path: 'Projekt' },
      { id: 'f-einreichung', parentId: 'f-root', name: 'Einreichung', path: 'Projekt/Einreichung' },
    ]
    const files = [
      pathed('Projekt/EG_Grundriss_Index_C.pdf'),
      pathed('Projekt/Einreichung/Neu/Schnitt_AA_Index_2.pdf'),
      pathed('Projekt/Einreichung/Ansicht_Nord_Index_B.pdf'),
    ]

    await act(async () => {
      await result.current.propose({ documents: [], folders, currentFolderId: 'f-root', files, fassungOffers: offers }, vi.fn())
    })

    expect(offers).toHaveBeenCalledWith(
      ['EG_Grundriss_Index_C.pdf', 'Schnitt_AA_Index_2.pdf', 'Ansicht_Nord_Index_B.pdf'],
      new Map([
        ['EG_Grundriss_Index_C.pdf', 'f-root'],
        ['Schnitt_AA_Index_2.pdf', 'f-einreichung'],
        ['Ansicht_Nord_Index_B.pdf', 'f-einreichung'],
      ]),
    )
  })

  it('makes no request at all for names without an index or a date', async () => {
    const offers = vi.fn(async () => [])
    const { result } = renderHook(() => useUploadDecision())

    await act(async () => {
      await result.current.propose({ ...base, files: [new File(['x'], 'Baubeschreibung.pdf')], fassungOffers: offers }, vi.fn())
    })

    expect(offers).not.toHaveBeenCalled()
  })

  it('uploads as it always did when the probe cannot answer: an offer is a convenience, never a gate', async () => {
    const sendDirect = vi.fn()
    const { result } = renderHook(() => useUploadDecision())
    const file = new File(['x'], 'EG_Grundriss_Index_C.pdf')

    await act(async () => {
      await result.current.propose(
        { ...base, files: [file], fassungOffers: vi.fn().mockRejectedValue(new Error('offline')) },
        sendDirect
      )
    })

    expect(sendDirect).toHaveBeenCalledWith([file])
  })

  it('re-plans on a change: one file, a whole group, and a picked candidate', async () => {
    const offers = vi.fn(async (names: readonly string[]) => names.map((name) => answer(name, ['b', 'a'])))
    const { result } = renderHook(() => useUploadDecision())
    const first = new File(['x'], 'EG_Grundriss_Index_C.pdf')
    const second = new File(['x'], 'OG_Grundriss_Index_C.pdf')

    await act(async () => {
      await result.current.propose({ ...base, files: [first, second], fassungOffers: offers }, vi.fn())
    })
    await waitFor(() => expect(result.current.plan?.files[0].fassungOf).toBeDefined())
    const chosen = () => result.current.plan?.files.map((file) => file.fassungOf?.chosen)

    expect(chosen()).toEqual([false, false])
    act(() => result.current.changeFassung({ files: [first, second], chosen: true }))
    expect(chosen()).toEqual([true, true])
    act(() => result.current.changeFassung({ files: [second], chosen: false }))
    expect(chosen()).toEqual([true, false])
    act(() => result.current.changeFassung({ files: [second], targetId: 'a' }))
    expect(result.current.plan?.files[1].fassungOf).toMatchObject({ of: { id: 'a' }, chosen: true })
  })

  it('carries the answers into the settled plan the upload applies', async () => {
    const offers = vi.fn(async (names: readonly string[]) => names.map((name) => answer(name)))
    const { result } = renderHook(() => useUploadDecision())
    const file = new File(['x'], 'EG_Grundriss_Index_C.pdf')

    await act(async () => {
      await result.current.propose({ ...base, files: [file], fassungOffers: offers }, vi.fn())
    })
    await waitFor(() => expect(result.current.plan?.files[0].fassungOf).toBeDefined())
    act(() => result.current.changeFassung({ files: [file], chosen: false }))

    let settled: Awaited<ReturnType<typeof result.current.settle>> = null
    await act(async () => {
      settled = await result.current.settle()
    })

    expect(settled!.plan.files[0].fassungOf?.chosen).toBe(false)
  })
})
