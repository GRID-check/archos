/**
 * @vitest-environment node
 */
import { describe, expect, test } from 'vitest'

import { isControlFlowExceptionEvent, isFrameworkControlFlow } from './control-flow-error'

describe('isFrameworkControlFlow', () => {
  test('knows a redirect by its digest or by the bare message a server action rejection carries', () => {
    expect(isFrameworkControlFlow(Object.assign(new Error('x'), { digest: 'NEXT_REDIRECT;push;/app/projects;307;' }))).toBe(true)
    expect(isFrameworkControlFlow(new Error('NEXT_REDIRECT'))).toBe(true)
    expect(isFrameworkControlFlow('NEXT_REDIRECT')).toBe(true)
  })

  test('knows notFound() and the HTTP access fallbacks', () => {
    expect(isFrameworkControlFlow(Object.assign(new Error('x'), { digest: 'NEXT_NOT_FOUND' }))).toBe(true)
    expect(isFrameworkControlFlow(Object.assign(new Error('x'), { digest: 'NEXT_HTTP_ERROR_FALLBACK;404' }))).toBe(true)
  })

  test('a real failure, or one that only mentions a marker, is not control flow', () => {
    expect(isFrameworkControlFlow(new Error('Failed to load NEXT_REDIRECT config'))).toBe(false)
    expect(isFrameworkControlFlow(new Error('boom'))).toBe(false)
    expect(isFrameworkControlFlow(null)).toBe(false)
    expect(isFrameworkControlFlow(42)).toBe(false)
  })
})

describe('isControlFlowExceptionEvent', () => {
  test('reads the serialised $exception the autocapture sends', () => {
    expect(isControlFlowExceptionEvent('$exception', { $exception_list: [{ value: 'NEXT_REDIRECT' }] })).toBe(true)
    expect(isControlFlowExceptionEvent('$exception', { $exception_message: 'NEXT_NOT_FOUND' })).toBe(true)
    expect(isControlFlowExceptionEvent('$exception', { $exception_list: [{ value: 'boom' }] })).toBe(false)
    expect(isControlFlowExceptionEvent('$pageview', { $exception_message: 'NEXT_REDIRECT' })).toBe(false)
  })
})
