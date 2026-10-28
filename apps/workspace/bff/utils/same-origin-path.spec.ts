/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import { appReturnPath, isSameOriginPath, MAX_RETURN_PATH_LENGTH } from './same-origin-path'

describe('same-origin paths', () => {
  it.each([
    ['/app/inbox', true],
    ['//evil.example', false],
    ['https://x.example', false],
    ['/\\evil.example', false],
    ['app/inbox', false],
  ])('%s -> %s', (value, expected) => {
    expect(isSameOriginPath(value)).toBe(expected)
  })
})

describe('a path to return to inside the app', () => {
  it('keeps a page of the app with its filters and anchor', () => {
    expect(appReturnPath('/app/projects/p1/files/open-points?assignee=me&due=overdue#doc-2')).toBe(
      '/app/projects/p1/files/open-points?assignee=me&due=overdue#doc-2'
    )
  })

  it.each([
    ['another site', 'https://evil.example/app/x'],
    ['a scheme', 'javascript:alert(1)'],
    ['protocol-relative', '//evil.example/app/x'],
    ['a backslash', '/\\evil.example/app'],
    ['a tab the parser would drop', '/\t/evil.example/app/x'],
    ['a newline', '/app/x\n'],
    ['outside the app', '/api/inbox/read'],
    ['a dot path out of the app', '/app/../api/inbox'],
    ['relative', 'app/inbox'],
    ['nothing', ''],
    ['too long', `/app/${'x'.repeat(MAX_RETURN_PATH_LENGTH)}`],
  ])('refuses %s', (_case, value) => {
    expect(appReturnPath(value)).toBeNull()
  })

  it('refuses null', () => {
    expect(appReturnPath(null)).toBeNull()
  })
})
