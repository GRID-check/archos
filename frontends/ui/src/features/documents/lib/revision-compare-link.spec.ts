import { describe, expect, it } from 'vitest'
import { COMPARE_PARAM, compareRevisionHref } from './revision-compare-link'

describe('compareRevisionHref', () => {
  it('asks a project document link for the comparison with the older Fassung', () => {
    expect(compareRevisionHref('/app/projects/p1/files?doc=doc-b', 'doc-a')).toBe(
      `/app/projects/p1/files?doc=doc-b&${COMPARE_PARAM}=doc-a`
    )
  })

  it('works for the Büroablage link too, and keeps a hash', () => {
    expect(compareRevisionHref('/app/archiv?doc=doc-b#top', 'doc-a')).toBe(
      '/app/archiv?doc=doc-b&compare=doc-a#top'
    )
  })

  it('replaces an earlier comparison rather than adding a second', () => {
    expect(compareRevisionHref('/app/archiv?doc=b&compare=old', 'a')).toBe(
      '/app/archiv?doc=b&compare=a'
    )
  })

  it('encodes the id', () => {
    expect(compareRevisionHref('/x?doc=b', 'a b&c')).toBe('/x?doc=b&compare=a+b%26c')
  })

  it('is null without a link', () => {
    expect(compareRevisionHref(null, 'a')).toBeNull()
  })
})
