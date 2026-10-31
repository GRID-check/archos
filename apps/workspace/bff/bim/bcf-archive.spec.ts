/**
 * @vitest-environment node
 */
/**
 * The BCF archive reader against archives built to hurt (`./bcf-archive.ts`):
 * paths that climb, members that inflate past their bounds (declared honestly
 * or lied about), too many members, encryption, damage. Each refuses the whole
 * archive with its reason; a well-formed one gives its files.
 */

import { strToU8, zipSync, type Zippable } from 'fflate'
import { describe, expect, it } from 'vitest'
import { BcfArchiveError, MAX_BCF_ENTRIES, MAX_BCF_ENTRY_BYTES, readBcfArchive, safeMemberPath } from './bcf-archive'

const refusal = (bytes: Uint8Array): string => {
  try {
    readBcfArchive(bytes)
    return 'read'
  } catch (error) {
    if (error instanceof BcfArchiveError) return error.reason
    throw error
  }
}

/** The offset of a member's central directory entry, found by its name. */
function centralEntry(bytes: Uint8Array, name: string): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const wanted = strToU8(name)
  for (let at = 0; at + 46 < bytes.length; at += 1) {
    if (view.getUint32(at, true) !== 0x02014b50) continue
    const length = view.getUint16(at + 28, true)
    if (length === wanted.length && wanted.every((byte, index) => bytes[at + 46 + index] === byte)) return at
  }
  throw new Error(`no central entry for ${name}`)
}

const zip = (files: Zippable, level: 0 | 9 = 9) => zipSync(files, { level, mtime: new Date('2026-10-31T00:00:00Z') })

describe('readBcfArchive', () => {
  it('gives the files of a well-formed archive by path, folders left out', () => {
    const files = readBcfArchive(
      zip({ 'bcf.version': strToU8('<Version VersionId="2.1"/>'), 'abc/': new Uint8Array(0), 'abc/markup.bcf': strToU8('<Markup/>') })
    )
    expect([...files.keys()]).toEqual(['bcf.version', 'abc/markup.bcf'])
    expect(new TextDecoder().decode(files.get('abc/markup.bcf'))).toBe('<Markup/>')
  })

  it.each(['../evil.bcf', '../../etc/passwd', 'a/../../b', '/etc/passwd', 'a\\..\\b', 'C:/x', 'a/b/c', './x', 'a//b'])(
    'refuses a member called %j as an unsafe path',
    (name) => {
      expect(refusal(zip({ [name]: strToU8('x') }))).toBe('unsafe_path')
    }
  )

  it('refuses the same member twice', () => {
    const bytes = zip({ 'a/markup.bcf': strToU8('one'), 'b/markup.bcf': strToU8('two') }, 0)
    // Rename the second to the first, in the directory only: what a crafted archive does.
    bytes.set(strToU8('a'), centralEntry(bytes, 'b/markup.bcf') + 46)
    expect(refusal(bytes)).toBe('unsafe_path')
  })

  it('refuses a member that declares more than its bound, before inflating it', () => {
    expect(refusal(zip({ 'big.bin': new Uint8Array(MAX_BCF_ENTRY_BYTES + 1) }))).toBe('too_large')
  })

  it('refuses members that together declare more than the archive may unpack to', () => {
    const fifteen = new Uint8Array(15 * 1024 * 1024)
    const files: Zippable = {}
    for (let index = 0; index < 18; index += 1) files[`t${index}/snapshot.png`] = fifteen
    expect(refusal(zip(files))).toBe('too_large')
  })

  it('refuses a bomb that lies about its size the moment it inflates past what it declared', () => {
    const bytes = zip({ 'a/markup.bcf': new Uint8Array(8 * 1024 * 1024) })
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    view.setUint32(centralEntry(bytes, 'a/markup.bcf') + 24, 100, true)
    expect(refusal(bytes)).toBe('too_large')
  })

  it('refuses more members than a BCF file of a full document has', () => {
    const files: Zippable = {}
    for (let index = 0; index <= MAX_BCF_ENTRIES; index += 1) files[`t${index}.txt`] = new Uint8Array(0)
    expect(refusal(zip(files, 0))).toBe('too_many_entries')
  })

  it('refuses an encrypted member', () => {
    const bytes = zip({ 'a/markup.bcf': strToU8('<Markup/>') })
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const at = centralEntry(bytes, 'a/markup.bcf')
    view.setUint16(at + 8, view.getUint16(at + 8, true) | 1, true)
    expect(refusal(bytes)).toBe('encrypted')
  })

  it('refuses a member whose bytes do not match their CRC', () => {
    const bytes = zip({ 'a/markup.bcf': strToU8('<Markup>damaged</Markup>') }, 0)
    const at = bytes.indexOf(strToU8('damaged')[0], 40)
    bytes[at] ^= 0xff
    expect(refusal(bytes)).toBe('corrupt')
  })

  it('refuses bytes that are no ZIP archive', () => {
    expect(refusal(strToU8('<?xml version="1.0"?><Markup/>'))).toBe('not_a_zip')
    expect(refusal(new Uint8Array(4))).toBe('not_a_zip')
  })
})

describe('safeMemberPath', () => {
  it('takes the paths BCF writes', () => {
    for (const path of ['bcf.version', 'extensions.xml', 'project.bcfp', '0f0e6d6a-1b2c-4d3e-8f9a-0b1c2d3e4f5a/markup.bcf', 'abc/']) {
      expect(safeMemberPath(path)).toBe(path)
    }
  })
})
