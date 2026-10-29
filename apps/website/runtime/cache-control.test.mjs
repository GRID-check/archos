import assert from 'node:assert/strict'
import { test } from 'node:test'
import { IMMUTABLE, LONG_REVALIDATE, cacheControlFor } from './cache-control.mjs'

test('hashed build assets are immutable', () => {
  assert.equal(cacheControlFor('/_astro/BaseLayout.M30jRaNT.css'), IMMUTABLE)
})

test('unhashed media revalidate after a week, never immutable', () => {
  assert.equal(cacheControlFor('/media/product-model-check.webp'), LONG_REVALIDATE)
  assert.equal(cacheControlFor('/media/share-card.jpg'), LONG_REVALIDATE)
})

test('pages and server routes keep the adapter default', () => {
  // HTML must revalidate on every view, or a deploy is invisible for a week.
  for (const path of ['/', '/en/', '/blog/', '/sign-in', '/web-analytics.js', '/robots.txt']) {
    assert.equal(cacheControlFor(path), undefined, path)
  }
})

test('a prefix only matches a whole directory', () => {
  assert.equal(cacheControlFor('/_astro'), undefined)
  assert.equal(cacheControlFor('/media'), undefined)
  assert.equal(cacheControlFor('/mediathek/'), undefined)
})
