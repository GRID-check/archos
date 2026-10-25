import { describe, expect, it } from 'vitest'
import { safeReturnPathname } from './return-pathname'

describe('safeReturnPathname', () => {
  it('keeps a path on this app, with its query', () => {
    expect(safeReturnPathname('/app/projects/abc/chat?tab=files')).toBe('/app/projects/abc/chat?tab=files')
  })

  it('has no answer when the request carried none', () => {
    expect(safeReturnPathname(null)).toBeUndefined()
    expect(safeReturnPathname(undefined)).toBeUndefined()
    expect(safeReturnPathname('')).toBeUndefined()
  })

  it('refuses another origin, in every spelling the URL parser accepts', () => {
    for (const candidate of [
      'https://evil.example/app',
      '//evil.example/app',
      '/\\evil.example/app',
      'http://evil.example',
      '\t//evil.example/app',
    ]) {
      expect(safeReturnPathname(candidate), candidate).toBeUndefined()
    }
  })

  it('refuses an API path', () => {
    expect(safeReturnPathname('/api')).toBeUndefined()
    expect(safeReturnPathname('/api/v1/projects')).toBeUndefined()
  })

  it('refuses a value that is not a path', () => {
    expect(safeReturnPathname('app/projects')).toBeUndefined()
  })
})
