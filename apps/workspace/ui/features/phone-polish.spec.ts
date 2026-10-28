// @disk-inputs: app/app/(shell)/inbox/inbox-sheet.tsx, ui/features/bim/components/viewer/viewer-tool-button.tsx, ui/features/chat/components/AgentPrompt.tsx, ui/features/chat/components/effort-dial/EffortDial.tsx, ui/features/documents/components/file-workspace.tsx
/**
 * Static ratchets for the phone details that fail without a sound: a list that
 * ends under the home indicator, a caption that ellipsizes, a layout animation
 * written by hand. Each reads the source because the pixels are a capture's job
 * (`docs/ux/visual-screenshots.md`) and the class of defect is a missing line.
 */

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { srcJoin } from '@/test-utils/source-tree'

const read = (...parts: string[]): string => readFileSync(srcJoin(...parts), 'utf8')

describe('a sheet that reaches the screen edge ends its list above the home indicator', () => {
  it('Inbox', () => {
    expect(read('app', 'app', '(shell)', 'inbox', 'inbox-sheet.tsx')).toContain(
      'env(safe-area-inset-bottom)'
    )
  })

  it('Archiv, which is the Dateien workspace on the office shelf', () => {
    const workspace = read('features', 'documents', 'components', 'file-workspace.tsx')
    expect(workspace).toContain("const inSheet = shelf.source === 'office'")
    expect(workspace).toContain('pb-[env(safe-area-inset-bottom)]')
  })
})

describe('the phone dock names its tools whole', () => {
  it('keeps the caption at 11px and gives it the width of the tool, with no side padding', () => {
    const tool = read('features', 'bim', 'components', 'viewer', 'viewer-tool-button.tsx')
    expect(tool).toContain('text-[11px]')
    expect(tool).toContain('px-0 py-1.5')
  })
})

describe('the effort dial arrives through the shared primitive', () => {
  it('writes no height of its own', () => {
    const dial = read('features', 'chat', 'components', 'effort-dial', 'EffortDial.tsx')
    expect(dial).toContain('HeightArrival')
    expect(dial).not.toMatch(/height:\s*'auto'/)
  })
})

describe('a decision row stacks on a phone', () => {
  it('the plan approval uses the cards’ DECISION_ROW and gives every button its DECISION_BUTTON', () => {
    const prompt = read('features', 'chat', 'components', 'AgentPrompt.tsx')
    expect(prompt).toContain('className={DECISION_ROW}')
    expect(prompt.match(/className=\{DECISION_BUTTON\}/g)).toHaveLength(3)
  })
})
