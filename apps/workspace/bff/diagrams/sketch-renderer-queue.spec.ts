/**
 * @vitest-environment node
 */
/**
 * The renderer's queue policy, against fake workers: one organization's share
 * of the queue, the cap on text to lay out, and the worker recycled between
 * renders (`sketch-renderer.ts`). The real worker is `sketch-renderer.spec.ts`'s.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createSketchRenderer, MAX_QUEUED_PER_ORGANIZATION, MAX_REMEASURED_CHARS, RECYCLE_HEAP_MB } from './sketch-renderer'

let dir = ''
const fake = (name: string, body: string) => {
  const path = join(dir, name)
  writeFileSync(path, `import { parentPort, threadId } from 'node:worker_threads'\n${body}\n`)
  return path
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'sketch-renderer-queue-'))
})
afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
})

const empty = (organizationId: string) => ({ elements: [], remeasure: [], organizationId })

describe('the render queue', () => {
  it('holds at most four places for one organization, and still takes another’s', async () => {
    const renderer = createSketchRenderer({ workerPath: fake('hang.mjs', "parentPort.on('message', () => {})"), fontsDir: dir, timeoutMs: 60_000 })
    const held = Array.from({ length: MAX_QUEUED_PER_ORGANIZATION }, () => renderer.render(empty('org_a')).catch(() => undefined))
    await expect(renderer.render(empty('org_a'))).rejects.toMatchObject({ reason: 'busy' })
    const other = renderer.render(empty('org_b')).catch(() => undefined)
    await renderer.close()
    void Promise.all([...held, other])
  })

  it('refuses a render with more text to lay out than the cap, before it is queued', async () => {
    const renderer = createSketchRenderer({ workerPath: join(dir, 'never-started.mjs'), fontsDir: dir })
    const text = 'x'.repeat(5_000)
    const elements = Array.from({ length: MAX_REMEASURED_CHARS / 5_000 + 1 }, (_, i) => ({ id: `t${i}`, type: 'text', text, originalText: text }))
    await expect(renderer.render({ elements, remeasure: elements.map((element) => element.id), organizationId: 'org_a' })).rejects.toMatchObject({
      reason: 'too_much_text',
    })
    // Texts that are not laid out again cost nothing: the cap does not count them.
    await expect(renderer.render({ elements, remeasure: [], organizationId: 'org_a' })).rejects.toMatchObject({ reason: 'unavailable' })
  })

  const answering = (heapMb: number) =>
    fake(
      `answer-${heapMb}.mjs`,
      `parentPort.on('message', (request) => parentPort.postMessage({ id: request.id, ok: true, svg: String(threadId), remeasured: [], ms: 1, heapMb: ${heapMb} }))`
    )

  it('starts a fresh worker after so many renders', async () => {
    const renderer = createSketchRenderer({ workerPath: answering(10), fontsDir: dir, recycleAfter: 2 })
    const threads = []
    for (let i = 0; i < 3; i++) threads.push((await renderer.render(empty('org_a'))).svg)
    expect(threads[0]).toBe(threads[1])
    expect(threads[2]).not.toBe(threads[1])
    await renderer.close()
  })

  it('starts a fresh worker once the heap passes the threshold', async () => {
    const renderer = createSketchRenderer({ workerPath: answering(RECYCLE_HEAP_MB + 1), fontsDir: dir })
    const first = (await renderer.render(empty('org_a'))).svg
    const second = (await renderer.render(empty('org_a'))).svg
    expect(second).not.toBe(first)
    await renderer.close()
  })
})
