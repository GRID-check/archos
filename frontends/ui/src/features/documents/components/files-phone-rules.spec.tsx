import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'

import { everythingRead } from './folder-brief'
import { AssignmentFaces } from './assignment-faces'
import { emptyTally } from '../lib/folder-knowledge'

const source = (file: string): string => readFileSync(join(__dirname, file), 'utf8')

/**
 * The phone rules of the Dateien screen (393px wide: the first document must
 * start in the top third). Each is a class or a predicate that a later edit can
 * drop without any behaviour test noticing, so they are pinned here.
 */
describe('Dateien on a phone', () => {
  it('the folder disclosure has nothing to say when everything is read', () => {
    const read = { ...emptyTally(), total: 2, readable: 2 }
    expect(everythingRead(read)).toBe(true)
    // Something unread, failing or held brings it back.
    expect(everythingRead({ ...read, readable: 1, reading: 1 })).toBe(false)
    expect(everythingRead({ ...read, readable: 1, failed: 1 })).toBe(false)
    expect(everythingRead({ ...read, readable: 1, held: 1 })).toBe(false)
    // A file Piloti is not meant to read is not unread.
    expect(everythingRead({ ...read, total: 3, unindexed: 1 })).toBe(true)
  })

  it('the brief renders nothing on a phone when everything is read (gate is in the component)', () => {
    const src = source('folder-brief.tsx')
    expect(src).toMatch(/if \(phone && everythingRead\(tally\)\) return null/)
  })

  it('the list ends 6rem above the floor so the last row scrolls clear of the floating Hochladen', () => {
    const src = source('file-workspace.tsx')
    expect(src).toContain("'pb-[calc(6rem+env(safe-area-inset-bottom))]'")
    expect(src).toContain("'pb-24'")
    // The button itself is not touched by this rule.
    expect(source('upload-fab.tsx')).toContain("'bottom-4'")
  })

  it('the breadcrumb row pins to the top of the list on a phone instead of scrolling half under the header', () => {
    const row = source('folder-navigation.tsx')
    expect(row).toContain('phone:sticky phone:top-0 phone:z-10 phone:bg-background')
    // Sticky only sticks inside a parent as tall as the content.
    expect(source('file-browser-pane.tsx')).toContain('phone:h-auto phone:min-h-full')
  })

  it('an unassigned card shows a disc on a phone and keeps the word for the wide card and for screen readers', () => {
    render(<AssignmentFaces assignees={[]} />)
    const mark = screen.getByTestId('assignment-unassigned')
    const word = screen.getByText('Unassigned')
    expect(word.className).toContain('phone:sr-only')
    expect(mark.querySelector('[aria-hidden]')?.className).toContain('phone:flex')
  })
})
