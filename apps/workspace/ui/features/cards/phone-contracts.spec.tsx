// @disk-inputs: ui/features/cards/**
/**
 * What the chat cards keep on a phone, held where the source shows it.
 *
 * Pixels belong to the browser (`/dev/cards` on an iPhone 15 Pro); these are the
 * class-of-defect rules that are visible in the source and invisible on a
 * desktop, the same shape as `components/ui/mobile-affordances.spec.ts`:
 *
 *  1. Text is never cut with only a `title` to read it: a touch screen shows no
 *     tooltip. A clamp goes through `ClampedText`, which opens on a tap.
 *  2. The buttons of a proposal's decision row are all `DECISION_BUTTON`, so the
 *     row stacks, full width and one height, with „Übernehmen" first.
 *  3. The one openable row in the card set grows to 44px under a finger.
 *  4. A check's label wraps instead of truncating.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { render as rtlRender, screen } from '@testing-library/react'
import type { ReactElement } from 'react'
import { I18nProvider } from '@/i18n'
import { blankComments } from '../../../scripts/check-static-utility-modifiers.mjs'
import { KeyTakeawaysCard } from './components/KeyTakeawaysCard'
import { DimChecksList } from './schematics/kit'

const ROOT = __dirname

const sources = (dir: string, out: string[] = []): string[] => {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) sources(path, out)
    else if (/\.tsx$/.test(entry) && !/\.(spec|test)\.tsx$/.test(entry)) out.push(path)
  }
  return out
}

const code = (file: string): string => blankComments(readFileSync(file, 'utf8')) as string
const name = (file: string): string => file.slice(ROOT.length + 1)

describe('a cut text always has a way to read it on touch', () => {
  it('no element truncates while holding its text in a `title`', () => {
    const offenders: string[] = []
    for (const file of sources(ROOT)) {
      // One JSX opening tag, allowing one level of `{…}` inside an attribute.
      for (const tag of code(file).matchAll(/<[A-Za-z][\w.]*\b(?:[^<>{}]|\{[^{}]*\})*>/g)) {
        if (/(?<![\w:-])truncate\b/.test(tag[0]) && /\btitle=/.test(tag[0])) offenders.push(name(file))
      }
    }
    expect(offenders).toEqual([])
  })

  it('`line-clamp` lives in ClampedText only, which opens on a tap', () => {
    const offenders = sources(ROOT)
      .filter((file) => !file.endsWith('ClampedText.tsx'))
      .filter((file) => /\bline-clamp-\d/.test(code(file)))
      .map(name)
    expect(offenders).toEqual([])
  })
})

describe('a proposal’s decision row stacks on a phone', () => {
  const FILES = ['components/ProposalReceipt.tsx', 'components/MemoryProposalCard.tsx', 'components/ProjectProfilePatchCard.tsx']

  it.each(FILES)('%s: one DECISION_ROW, and every button is a DECISION_BUTTON', (file) => {
    const source = code(join(ROOT, file))
    expect(source.match(/<Button\b/g)?.length).toBe(source.match(/cn\(DECISION_BUTTON\b/g)?.length)
    expect(source).toContain('DECISION_ROW')
  })

  it('ProposalReceipt puts „Übernehmen" before its alternative and before „Verwerfen"', () => {
    const source = code(join(ROOT, 'components/ProposalReceipt.tsx'))
    const accept = source.indexOf("t('cards.proposalReceipt.accept')")
    const alternative = source.indexOf('alternative.label')
    const reject = source.indexOf("t('cards.proposalReceipt.reject')")
    expect(accept).toBeGreaterThan(-1)
    expect(accept).toBeLessThan(alternative)
    expect(alternative).toBeLessThan(reject)
  })
})

const render = (ui: ReactElement) =>
  rtlRender(
    <I18nProvider initialLocale="de" fixedLocale>
      {ui}
    </I18nProvider>
  )

describe('KeyTakeawaysCard on a phone', () => {
  it('grows an openable row to the 44px floor under a coarse pointer', () => {
    render(<KeyTakeawaysCard title={null} items={[{ text: 'Brandwand erforderlich', detail: 'Ab GK 4.' }]} />)

    expect(screen.getByRole('button', { name: /Brandwand/ })).toHaveClass('pointer-coarse:py-3')
  })
})

describe('DimChecksList', () => {
  it('wraps the label of the decisive check rather than clipping it', () => {
    const label = 'Lichteinfall 45° — Gegenüberliegendes Gebäude'
    render(
      <DimChecksList
        checks={[{ label, status: 'fail', value: 4.2, required: 6, comparator: '>=', unit: 'm' }]}
      />
    )

    const element = screen.getByText(label)
    expect(element).not.toHaveClass('truncate')
    expect(element.className).toContain('overflow-wrap')
    expect(element).not.toHaveAttribute('title')
  })
})
