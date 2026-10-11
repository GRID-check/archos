import { describe, expect, it } from 'vitest'
import { COMPARE_PARAM, compareFassungHref } from './fassung-compare-link'

describe('compareFassungHref', () => {
  it('asks a project document link for the comparison with the older Fassung', () => {
    expect(compareFassungHref('/app/projects/p1/files?doc=doc-b', 'doc-a')).toBe(
      `/app/projects/p1/files?doc=doc-b&${COMPARE_PARAM}=doc-a`
    )
  })

  it('works for the Büroablage link too, and keeps a hash', () => {
    expect(compareFassungHref('/app/archiv?doc=doc-b#top', 'doc-a')).toBe(
      '/app/archiv?doc=doc-b&compare=doc-a#top'
    )
  })

  it('replaces an earlier comparison rather than adding a second', () => {
    expect(compareFassungHref('/app/archiv?doc=b&compare=old', 'a')).toBe(
      '/app/archiv?doc=b&compare=a'
    )
  })

  it('encodes the id', () => {
    expect(compareFassungHref('/x?doc=b', 'a b&c')).toBe('/x?doc=b&compare=a+b%26c')
  })

  it('is null without a link', () => {
    expect(compareFassungHref(null, 'a')).toBeNull()
  })
})
