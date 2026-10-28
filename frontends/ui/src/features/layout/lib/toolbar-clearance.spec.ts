// @disk-inputs: src/features/layout/components/ChatArea.tsx, src/features/layout/components/chat-area/chat-message-list.tsx, src/features/layout/components/MainLayout.tsx
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  TOOLBAR_CLEAR_PADDING,
  TOOLBAR_CLEAR_SCROLL_MARGIN,
  toolbarClearance,
} from './toolbar-clearance'

const components = join(__dirname, '..', 'components')
const source = (file: string): string => readFileSync(join(components, file), 'utf8')

describe('toolbar clearance', () => {
  it('is the measured height plus a breath, in whole pixels', () => {
    expect(toolbarClearance(163)).toBe('171px')
    expect(toolbarClearance(112.4)).toBe('121px')
  })

  it('falls back to the one-row values until the toolbar has been measured', () => {
    expect(TOOLBAR_CLEAR_PADDING).toContain('var(--chat-toolbar-clear,max(5rem,')
    expect(TOOLBAR_CLEAR_PADDING).toContain('sm:pt-[var(--chat-toolbar-clear,max(3.5rem,')
    expect(TOOLBAR_CLEAR_SCROLL_MARGIN).toContain('var(--chat-toolbar-clear,')
  })

  it('is the only place the transcript decides how far down the toolbar reaches', () => {
    // The phone toolbar is two rows, and three while the link is gone: a clearance
    // written into a class list is the guess that put the first message under it.
    // The transcript is the message list the column renders, now in its own module.
    const area = source('ChatArea.tsx') + source('chat-area/chat-message-list.tsx')
    expect(area).not.toMatch(/pt-\[max\(5rem,calc\(env\(safe-area-inset-top\)\+4rem\)\)\]/)
    expect(area).not.toMatch(/scroll-mt-\[max\(5rem/)
    expect(area).toContain('TOOLBAR_CLEAR_PADDING')
    expect(area).toContain('TOOLBAR_CLEAR_SCROLL_MARGIN')
  })

  it('is published on the chat column from the toolbar the column holds', () => {
    const layout = source('MainLayout.tsx')
    expect(layout).toContain('onHeightChange={setToolbarHeight}')
    expect(layout).toContain('...toolbarVars')
  })
})
