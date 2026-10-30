import assert from 'node:assert/strict'
import { test } from 'node:test'
import { goneStatus, isGone } from './gone.mjs'

test('an old address with no successor is gone, with or without slash and query', () => {
  assert.equal(isGone('/rechenweg/'), true)
  assert.equal(isGone('/rechenweg'), true)
  assert.equal(isGone('/en/calculation/?utm_source=x'), true)
  assert.equal(isGone('/bildmaterial/alle.zip'), true)
})

test('a page, a redirect and an unknown address are not gone', () => {
  assert.equal(isGone('/'), false)
  assert.equal(isGone('/baurecht/'), false)
  assert.equal(isGone('/vergleich/chatgpt/'), false)
  assert.equal(isGone('/does-not-exist/'), false)
  assert.equal(isGone('/%E0%A4%A'), false)
})

/** A stand-in for http.ServerResponse that records the status written. */
function fakeResponse() {
  const res = { written: undefined }
  res.writeHead = (status) => {
    res.written = status
    return res
  }
  return res
}

test('the 404 of a gone address becomes 410; other statuses pass', () => {
  const gone = fakeResponse()
  goneStatus({ url: '/rechenweg/' }, gone)
  gone.writeHead(404, {})
  assert.equal(gone.written, 410)

  const ok = fakeResponse()
  goneStatus({ url: '/rechenweg/' }, ok)
  ok.writeHead(200, {})
  assert.equal(ok.written, 200)

  const unknown = fakeResponse()
  goneStatus({ url: '/does-not-exist/' }, unknown)
  unknown.writeHead(404, {})
  assert.equal(unknown.written, 404)
})
