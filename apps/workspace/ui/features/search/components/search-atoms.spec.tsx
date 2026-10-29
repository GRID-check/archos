import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ReactElement } from 'react'

import { render, screen } from '@/test-utils'
import { I18nProvider } from '@/i18n'
import { CommandDialog } from '@/components/ui/command'
import { ChoiceStrip, ComposerPickerFrame, FieldShortcut, MetaLine, MetaPart, leadUpToMatch } from './search-atoms'

const inGerman = (ui: ReactElement) =>
  render(
    <I18nProvider initialLocale="de" fixedLocale>
      {ui}
    </I18nProvider>
  )

afterEach(() => {
  vi.restoreAllMocks()
})

describe('MetaLine', () => {
  // The line pulls a 12px gutter (`-ml-3`) into its clipped left edge so the
  // dot of a part that starts a wrapped line is cut away. Any part with a
  // narrower gutter loses the difference from its own content when it is the
  // one that starts the line: the phone showed half a folder icon („ↄ Brandschutz“).
  it('gives every part, lead or not, the full gutter the line clips', () => {
    const { container } = render(
      <MetaLine
        lead={[<span key="shelf">Wohnhaus Seestadt</span>, <span key="folder">Brandschutz</span>]}
        parts={[<MetaPart key="type">Einreichplan</MetaPart>, null, <MetaPart key="index">Index C</MetaPart>]}
      />
    )
    const line = container.querySelector('.-ml-3')
    expect(line).not.toBeNull()
    const parts = Array.from(container.querySelectorAll('[data-meta-part]'))
    expect(parts).toHaveLength(4)
    for (const part of parts) expect(part.className).toMatch(/(^|\s)pl-3(\s|$)/)
  })

  it('sets no dot between lead parts and one before every other part', () => {
    const { container } = render(
      <MetaLine lead={[<span key="shelf">Seestadt</span>, <span key="folder">Brandschutz</span>]} parts={[<MetaPart key="type">Einreichplan</MetaPart>]} />
    )
    const dots = Array.from(container.querySelectorAll('[data-meta-part]')).map((part) => part.querySelector('[aria-hidden]')?.textContent?.trim() ?? '')
    expect(dots).toEqual(['·', '', '·'])
  })
})

describe('FieldShortcut', () => {
  // The field said „Strg K“ from its own dictionary entry while the palette's
  // „Alle Treffer“ row said „Ctrl ↵“ from the shell's: one key, two names.
  it('names the control key as the shell does, in the reader\'s language', () => {
    vi.spyOn(window.navigator, 'platform', 'get').mockReturnValue('Win32')
    const { container } = inGerman(<FieldShortcut />)
    expect(Array.from(container.querySelectorAll('kbd')).map((key) => key.textContent)).toEqual(['Strg', 'K'])
  })

  it('shows ⌘ on a Mac', () => {
    vi.spyOn(window.navigator, 'platform', 'get').mockReturnValue('MacIntel')
    const { container } = inGerman(<FieldShortcut />)
    expect(Array.from(container.querySelectorAll('kbd')).map((key) => key.textContent)).toEqual(['⌘', 'K'])
  })
})

describe('ComposerPickerFrame', () => {
  it('labels its keys with the palette\'s own footer, each key beside its word', () => {
    const hints = { move: 'bewegen', open: 'einfügen', close: 'schließen' }
    const { container } = inGerman(
      <ComposerPickerFrame hints={hints}>
        <div />
      </ComposerPickerFrame>
    )
    const footer = container.querySelector('[data-slot="command-hints"]')
    expect(footer).not.toBeNull()
    expect(footer!.textContent).toBe('↑↓bewegen↵einfügenEscschließen')
  })

  it('is the same footer the palette draws', () => {
    const hints = { move: 'bewegen', open: 'öffnen', close: 'schließen' }
    inGerman(
      <CommandDialog open title="Befehlspalette" description="" showHints hintLabels={hints}>
        <div />
      </CommandDialog>
    )
    const palette = document.querySelector('[data-slot="command-hints"]')!
    const { container } = inGerman(
      <ComposerPickerFrame hints={hints}>
        <div />
      </ComposerPickerFrame>
    )
    const picker = container.querySelector('[data-slot="command-hints"]')!
    expect(picker.innerHTML.replace(/ pointer-coarse:hidden/, '')).toBe(palette.innerHTML)
  })
})

describe('ChoiceStrip', () => {
  it('says with a chevron that the kinds go on past the edge', () => {
    vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockReturnValue(520)
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(358)
    const { container } = render(
      <ChoiceStrip label="Art">
        <div />
      </ChoiceStrip>
    )
    expect(screen.getByRole('region', { name: 'Art' })).toBeInTheDocument()
    expect(container.querySelectorAll('svg.lucide-chevron-right')).toHaveLength(1)
  })
})

describe('leadUpToMatch', () => {
  // The palette shows a passage on one line, about forty characters of it: a
  // match past that was cut off, and the line said nothing about why it matched.
  it('starts a long lead-in a few words before the first match, on a word boundary', () => {
    const lead = 'Laut Gutachten der MA 37 vom Oktober beträgt die maximale '
    const shown = leadUpToMatch([
      { text: lead, match: false },
      { text: 'Fluchtweglänge', match: true },
      { text: ' 40 m.', match: false },
    ])
    expect(shown[0].text.length).toBeLessThanOrEqual(32)
    expect(lead.endsWith(shown[0].text)).toBe(true)
    expect(shown[0].text.startsWith(' ')).toBe(false)
    expect(shown[1]).toEqual({ text: 'Fluchtweglänge', match: true })
  })

  it('leaves a passage whose match is near the start, or that has none, as it is', () => {
    const near = [{ text: 'Die ', match: false }, { text: 'Fluchtweglänge', match: true }]
    const none = [{ text: 'Kein Treffer hier', match: false }]
    expect(leadUpToMatch(near)).toBe(near)
    expect(leadUpToMatch(none)).toBe(none)
  })
})
