/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'

import { de } from './de'
import { en } from './en'
import { legalSlugs, type LegalDocument } from '../types'

/**
 * The legal text states what the product sends. PostHog receives product
 * analytics, masked replays, errors, surveys and support messages, and stores
 * `ph_…` entries in the browser, so a notice that still claims "only strictly
 * necessary cookies" is wrong, and a processor table without PostHog hides a
 * recipient. These specs hold the copy to that, in both languages.
 */

const flatten = (doc: LegalDocument): string =>
  doc.sections
    .flatMap((section) => [
      section.heading ?? '',
      ...(section.paragraphs ?? []),
      ...(section.list ?? []),
      ...(section.table ? [...section.table.headers, ...section.table.rows.flat()] : []),
      section.notice ?? '',
    ])
    .join('\n')

describe.each([
  ['de', de],
  ['en', en],
] as const)('legal content (%s)', (_locale, content) => {
  it('names PostHog and its EU hosting in the privacy policy', () => {
    const privacy = flatten(content.privacy)
    expect(privacy).toContain('PostHog, Inc.')
    expect(privacy).toContain('Frankfurt')
    expect(privacy).toContain('Langfuse')
  })

  it('lists PostHog in the processor table', () => {
    const processors = content.subprocessors.sections[0]?.table?.rows ?? []
    expect(processors.some((row) => row[0] === 'PostHog, Inc.')).toBe(true)
  })

  it('states the ph_ storage keys and no longer claims strictly-necessary-only cookies', () => {
    const cookies = content.privacy.sections.find((section) => /7\. /.test(section.heading ?? ''))
    const text = (cookies?.paragraphs ?? []).join('\n')
    expect(text).toContain('ph_')
    expect(text).not.toMatch(/ausschließlich technisch notwendig|only strictly necessary/i)
    expect(text).not.toMatch(/kein Cookie-Einwilligungsbanner|no cookie consent banner/i)
  })

  it('does not claim that email or name reach product analytics', () => {
    expect(flatten(content.privacy)).toMatch(/E-Mail-Adresse und Ihr Name werden nicht|email address and name are not sent/)
  })

  // These pages are public (/legal/*). A value nobody has verified is a TODO(owner)
  // in a source comment, never a bracketed placeholder a visitor reads.
  it.each(legalSlugs)('%s renders no bracketed placeholder', (slug) => {
    const doc = content[slug]
    expect(`${doc.title}\n${doc.intro ?? ''}\n${flatten(doc)}`).not.toMatch(/\[[^\]]*\]/)
  })

  it('has been revised since the PostHog switch', () => {
    expect(content.privacy.updated >= '2026-10-10').toBe(true)
    expect(content.subprocessors.updated >= '2026-10-10').toBe(true)
  })
})

describe('legal content parity', () => {
  it.each(legalSlugs)('%s has the same shape in German and English', (slug) => {
    const shape = (doc: LegalDocument) =>
      doc.sections.map((section) => ({
        paragraphs: section.paragraphs?.length ?? 0,
        list: section.list?.length ?? 0,
        rows: section.table?.rows.length ?? 0,
        notice: Boolean(section.notice),
      }))
    expect(shape(en[slug])).toEqual(shape(de[slug]))
  })
})
