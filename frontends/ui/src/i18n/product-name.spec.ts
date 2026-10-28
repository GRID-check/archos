/**
 * @vitest-environment node
 */

/**
 * The copy names the product through one constant (`PRODUCT_NAME`,
 * `lib/brand.ts`): a dictionary string says `{productName}`, and the registry
 * puts the name in. A string that spells the name would survive the next
 * rename, so this fails on one, in either locale.
 */

import { describe, expect, it } from 'vitest'
import { PRODUCT_NAME } from '@/lib/brand'
import { en as enSource } from './dictionaries/en'
import { de as deSource } from './dictionaries/de'
import { dictionaries } from './dictionaries'
import { withProductName } from './product-name'

function strings(node: unknown, path = ''): [string, string][] {
  if (typeof node === 'string') return [[path, node]]
  if (node && typeof node === 'object') {
    return Object.entries(node).flatMap(([key, value]) => strings(value, path ? `${path}.${key}` : key))
  }
  return []
}

const spelled = new RegExp(`(?<![A-Za-z])${PRODUCT_NAME}(?![a-z])`)

describe('the product name in the copy', () => {
  it.each([
    ['en', enSource],
    ['de', deSource],
  ])('is never spelled in the %s source, only {productName}', (_locale, source) => {
    const offenders = strings(source).filter(([, value]) => spelled.test(value))
    expect(offenders.map(([path]) => path)).toEqual([])
  })

  it.each(Object.entries(dictionaries))('is filled in everywhere the %s registry hands out', (_locale, dictionary) => {
    const unfilled = strings(dictionary).filter(([, value]) => value.includes('{productName}'))
    expect(unfilled.map(([path]) => path)).toEqual([])
    expect(dictionary.common.productName).toBe(PRODUCT_NAME)
  })

  it('fills every occurrence, inside a plural branch too, and leaves other placeholders alone', () => {
    const filled = withProductName({ a: '{count, plural, one {{productName} liest} other {{productName} lesen}} {name}' })
    expect(filled.a).toBe(`{count, plural, one {${PRODUCT_NAME} liest} other {${PRODUCT_NAME} lesen}} {name}`)
  })
})
