/**
 * @vitest-environment node
 */
import { redirect } from 'next/navigation'
import { describe, expect, it } from 'vitest'
import { isRedirectSignal } from './redirect-signal'

const thrownBy = (run: () => void): unknown => {
  try {
    run()
  } catch (error) {
    return error
  }
  return undefined
}

describe('isRedirectSignal', () => {
  it('knows what redirect() throws', () => {
    expect(isRedirectSignal(thrownBy(() => redirect('/app/projects/p1/setup')))).toBe(true)
  })

  it('takes nothing else for one, a message that merely says so included', () => {
    expect(isRedirectSignal(new Error('NEXT_REDIRECT'))).toBe(false)
    expect(isRedirectSignal(Object.assign(new Error('x'), { digest: 'NEXT_NOT_FOUND' }))).toBe(false)
    expect(isRedirectSignal('NEXT_REDIRECT;push;/x;307;')).toBe(false)
    expect(isRedirectSignal(null)).toBe(false)
  })
})
