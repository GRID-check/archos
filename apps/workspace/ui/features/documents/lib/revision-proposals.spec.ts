import { describe, expect, it } from 'vitest'
import { countNewRevisions, groupByFolder, groupRevisionProposals, masterTarget, soleProposal } from './revision-proposals'
import type { RevisionTarget, PlannedFile } from './folder-upload-plan'

const target = (id: string): RevisionTarget => ({ id, filename: `${id}.pdf`, name: `${id}.pdf`, label: '' })

/** A planned file in `targetPath`, with a proposal, or without one when `proposal` is null. */
function planned(
  name: string,
  targetPath: string,
  proposal: { unambiguous: boolean; chosen: boolean; newer?: boolean } | null,
): PlannedFile {
  return {
    file: new File(['x'], name),
    originPath: targetPath ? `${targetPath}/${name}` : name,
    targetPath,
    action: 'new',
    ...(proposal
      ? {
          revisionOf: {
            candidates: [target('b')],
            of: target('b'),
            newer: proposal.newer ?? true,
            unambiguous: proposal.unambiguous,
            chosen: proposal.chosen,
          },
        }
      : {}),
  }
}

describe('groupRevisionProposals', () => {
  it('splits the clear matches from the unclear ones, and leaves files without a proposal out', () => {
    const files = [
      planned('A.pdf', '', { unambiguous: true, chosen: true }),
      planned('B.pdf', '', { unambiguous: false, chosen: false }),
      planned('C.pdf', '', null),
    ]

    const { detected, unclear } = groupRevisionProposals(files)

    expect(detected.map((file) => file.file.name)).toEqual(['A.pdf'])
    expect(unclear.map((file) => file.file.name)).toEqual(['B.pdf'])
  })

  it('sorts both groups by folder, then by name', () => {
    const files = [
      planned('b.pdf', 'Statik', { unambiguous: true, chosen: true }),
      planned('z.pdf', '', { unambiguous: true, chosen: true }),
      planned('a.pdf', 'Statik', { unambiguous: true, chosen: true }),
      planned('c.pdf', 'Architektur/EG', { unambiguous: true, chosen: true }),
      planned('y.pdf', 'Statik', { unambiguous: false, chosen: false }),
      planned('x.pdf', 'Architektur', { unambiguous: false, chosen: false }),
    ]

    const { detected, unclear } = groupRevisionProposals(files)

    expect(detected.map((file) => file.originPath)).toEqual(['z.pdf', 'Architektur/EG/c.pdf', 'Statik/a.pdf', 'Statik/b.pdf'])
    expect(unclear.map((file) => file.originPath)).toEqual(['Architektur/x.pdf', 'Statik/y.pdf'])
  })

  it('reports the master box over the clear matches only', () => {
    const clear = (chosen: boolean) => planned(`${chosen}.pdf`, '', { unambiguous: true, chosen })
    const unclearTicked = planned('u.pdf', '', { unambiguous: false, chosen: true })

    expect(groupRevisionProposals([clear(true), clear(true), unclearTicked]).master).toBe('all')
    expect(groupRevisionProposals([clear(false), unclearTicked]).master).toBe('none')
    expect(groupRevisionProposals([clear(true), planned('f.pdf', '', { unambiguous: true, chosen: false })]).master).toBe('some')
    expect(groupRevisionProposals([]).master).toBe('none')
  })

  it('answers a click on the master box: tick all unless all are ticked, and a half-filled box ticks all', () => {
    expect(masterTarget('none')).toBe(true)
    expect(masterTarget('some')).toBe(true)
    expect(masterTarget('all')).toBe(false)
  })

  it('sorts forty files of a publisher export without losing one', () => {
    const files = Array.from({ length: 40 }, (_, index) =>
      planned(`Blatt_${String(index).padStart(2, '0')}_Index_B.pdf`, index % 2 === 0 ? 'Grundrisse' : 'Schnitte', {
        unambiguous: true,
        chosen: true,
      }),
    )

    const { detected, master } = groupRevisionProposals(files)

    expect(detected).toHaveLength(40)
    expect(master).toBe('all')
    expect(detected[0].targetPath).toBe('Grundrisse')
    expect(detected[39].targetPath).toBe('Schnitte')
  })

  it('counts the ticked clear matches, for the master box\'s „33 von 34"', () => {
    const files = [
      planned('a.pdf', '', { unambiguous: true, chosen: true }),
      planned('b.pdf', '', { unambiguous: true, chosen: false }),
      planned('c.pdf', '', { unambiguous: true, chosen: true }),
      // A ticked unclear file is not under the master box.
      planned('d.pdf', '', { unambiguous: false, chosen: true }),
    ]

    expect(groupRevisionProposals(files).ticked).toBe(2)
  })
})

describe('groupByFolder', () => {
  it('cuts the sorted proposals into one run per folder, in order', () => {
    const { detected } = groupRevisionProposals([
      planned('b.pdf', 'Schnitte', { unambiguous: true, chosen: true }),
      planned('a.pdf', 'Grundrisse', { unambiguous: true, chosen: true }),
      planned('c.pdf', 'Grundrisse', { unambiguous: true, chosen: true }),
      planned('z.pdf', '', { unambiguous: true, chosen: true }),
    ])

    const runs = groupByFolder(detected)

    expect(runs.map((run) => [run.folder, run.files.map((file) => file.file.name)])).toEqual([
      ['', ['z.pdf']],
      ['Grundrisse', ['a.pdf', 'c.pdf']],
      ['Schnitte', ['b.pdf']],
    ])
  })

  it('has no runs for no proposals', () => {
    expect(groupByFolder([])).toEqual([])
  })
})

describe('countNewRevisions', () => {
  const update = (): PlannedFile => ({ file: new File(['x'], 'EG.pdf'), originPath: 'EG.pdf', targetPath: '', action: 'update' })

  it('counts the same-name updates that are sent and the ticked offers, nothing else', () => {
    const files = [
      update(),
      planned('a.pdf', '', { unambiguous: true, chosen: true }),
      planned('b.pdf', '', { unambiguous: true, chosen: false }),
      planned('c.pdf', '', null),
    ]

    expect(countNewRevisions(files, true)).toBe(2)
    // Unticked updates are skipped, so they come in as nothing at all.
    expect(countNewRevisions(files, false)).toBe(1)
  })
})

describe('soleProposal', () => {
  it('is the one dropped file when it continues a document', () => {
    const only = planned('A_Index_C.pdf', '', { unambiguous: true, chosen: true })
    expect(soleProposal([only])).toBe(only)
  })

  it('is nothing for a batch, or for one file that continues nothing', () => {
    const offer = { unambiguous: true, chosen: true }
    expect(soleProposal([planned('A.pdf', '', offer), planned('B.pdf', '', offer)])).toBeNull()
    expect(soleProposal([planned('A.pdf', '', null)])).toBeNull()
    expect(soleProposal([])).toBeNull()
  })
})
