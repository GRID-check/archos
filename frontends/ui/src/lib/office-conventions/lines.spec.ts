import { describe, expect, it } from 'vitest'
import { EXTRACTOR_VERSION, type OfficeConventions } from './extract'
import { conventionLines, linesForAgent, resolveLines, type StoredDecision } from './lines'
import { conventionLineSchema, type ConventionLine } from './office-conventions-wire'

type FilingLine = Extract<ConventionLine, { kind: 'filing' }>
type FolderLine = Extract<ConventionLine, { kind: 'folder' }>

const counted = (overrides: Partial<OfficeConventions> = {}): OfficeConventions => ({
  version: EXTRACTOR_VERSION,
  projects: 5,
  folders: [{ path: '03_Behörde', projects: 5, of: 5 }],
  filing: [{ docType: 'Gutachten', path: '03_Behörde/Gutachten', projects: 4, of: 5 }],
  documentNumber: { shape: 'A-00', projects: 4, of: 5 },
  revisionStyle: { style: 'letter', projects: 4, of: 5 },
  fileDate: { format: 'YYYYMMDD', projects: 4, of: 5 },
  ...overrides,
})

describe('conventionLines', () => {
  it('gives every line a key that names the value and not the counts', () => {
    const before = conventionLines(counted()).map((line) => line.key)
    const after = conventionLines(
      counted({ filing: [{ docType: 'Gutachten', path: '3 - behörde/GUTACHTEN', projects: 9, of: 9 }] })
    ).map((line) => line.key)
    expect(before).toEqual([
      'filing:gutachten>behörde/gutachten',
      'folder:behörde',
      'document_number:A-00',
      'revision_style:letter',
      'file_date:YYYYMMDD',
    ])
    expect(after[0]).toBe(before[0])
  })

  it('produces lines the wire schema accepts', () => {
    for (const line of conventionLines(counted())) expect(conventionLineSchema.safeParse(line).success).toBe(true)
  })
})

describe('resolveLines and linesForAgent', () => {
  const [filing, folder] = conventionLines(counted()) as [FilingLine, FolderLine, ...ConventionLine[]]
  const decided = (line: ConventionLine, decision: StoredDecision['decision']): StoredDecision => ({
    lineKey: line.key,
    decision,
    line,
    decidedBy: 'user-1',
    decidedAt: new Date('2026-10-22T08:00:00Z'),
  })

  it('lays decisions over the counted lines and keeps decided lines the count dropped', () => {
    const gone = decided({ ...folder, key: 'folder:fotos', path: 'Fotos' }, 'confirmed')
    const views = resolveLines(conventionLines(counted()), [decided(filing, 'declined'), gone])
    expect(views.map((view) => [view.line.key, view.decision, view.counted])).toEqual([
      ['filing:gutachten>behörde/gutachten', 'declined', true],
      ['folder:behörde', null, true],
      ['document_number:A-00', null, true],
      ['revision_style:letter', null, true],
      ['file_date:YYYYMMDD', null, true],
      ['folder:fotos', 'confirmed', false],
    ])
    expect(views[0]?.decidedBy).toBe('user-1')
  })

  it('shows the agent no declined line and every confirmed one', () => {
    const views = resolveLines(conventionLines(counted({ folders: [] })), [
      decided(filing, 'declined'),
      decided({ ...folder, key: 'folder:fotos', path: 'Fotos' }, 'confirmed'),
    ])
    const keys = linesForAgent(views).map((view) => view.line.key)
    expect(keys).not.toContain(filing.key)
    expect(keys).toContain('folder:fotos')
  })
})
