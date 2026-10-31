/**
 * @vitest-environment node
 */
/**
 * The BCF archive reader against archives built to hurt (`./bcf-archive.ts`):
 * paths that climb, members that share bytes, members that inflate past their
 * bounds (declared honestly or lied about), too many members, ZIP64, unknown
 * methods, encryption, damage. Each refuses the whole archive with its reason;
 * a well-formed one opens, and a member inflates only when it is read.
 */

import { strToU8, zipSync, type Zippable } from 'fflate'
import { describe, expect, it } from 'vitest'
import { BcfArchiveError, MAX_BCF_ENTRIES, MAX_BCF_XML_MEMBER_BYTES, openBcfArchive, safeMemberPath } from './bcf-archive'

const refusal = (work: () => unknown): string => {
  try {
    work()
    return 'read'
  } catch (error) {
    if (error instanceof BcfArchiveError) return error.reason
    throw error
  }
}

const opening = (bytes: Uint8Array) => refusal(() => openBcfArchive(bytes))

const viewOf = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

/** The offset of a member's central directory entry, found by its name. */
function centralEntry(bytes: Uint8Array, name: string): number {
  const view = viewOf(bytes)
  const wanted = strToU8(name)
  for (let at = 0; at + 46 < bytes.length; at += 1) {
    if (view.getUint32(at, true) !== 0x02014b50) continue
    const length = view.getUint16(at + 28, true)
    if (length === wanted.length && wanted.every((byte, index) => bytes[at + 46 + index] === byte)) return at
  }
  throw new Error(`no central entry for ${name}`)
}

const endOfDirectory = (bytes: Uint8Array): number => {
  const view = viewOf(bytes)
  for (let at = bytes.length - 22; at >= 0; at -= 1) if (view.getUint32(at, true) === 0x06054b50) return at
  throw new Error('no end record')
}

const zip = (files: Zippable, level: 0 | 9 = 9) => zipSync(files, { level, mtime: new Date('2026-10-31T00:00:00Z') })

/**
 * The overlapping-entry bomb: one deflated run of zeros, and a central
 * directory naming it sixteen times under sixteen names. Inflated per entry it
 * is sixteen times its size; each entry on its own is within every bound.
 */
function overlappingBomb(): Uint8Array {
  const single = zip({ 'a/markup.bcf': new Uint8Array(MAX_BCF_XML_MEMBER_BYTES) })
  const entryAt = centralEntry(single, 'a/markup.bcf')
  const end = endOfDirectory(single)
  const entry = single.slice(entryAt, end)
  const copies = 'abcdefghijklmnop'.split('').map((letter) => {
    const copy = entry.slice()
    copy[46] = letter.charCodeAt(0)
    return copy
  })
  const directory = new Uint8Array(copies.reduce((sum, copy) => sum + copy.length, 0))
  copies.reduce((at, copy) => (directory.set(copy, at), at + copy.length), 0)
  const record = single.slice(end, end + 22)
  const view = viewOf(record)
  view.setUint16(8, copies.length, true)
  view.setUint16(10, copies.length, true)
  view.setUint32(12, directory.length, true)
  view.setUint32(16, entryAt, true)
  const bytes = new Uint8Array(entryAt + directory.length + record.length)
  bytes.set(single.subarray(0, entryAt), 0)
  bytes.set(directory, entryAt)
  bytes.set(record, entryAt + directory.length)
  return bytes
}

describe('openBcfArchive', () => {
  it('opens a well-formed archive and gives its files by path, folders left out', () => {
    const archive = openBcfArchive(
      zip({ 'bcf.version': strToU8('<Version VersionId="2.1"/>'), 'abc/': new Uint8Array(0), 'abc/markup.bcf': strToU8('<Markup/>') })
    )
    expect(archive.paths).toEqual(['bcf.version', 'abc/markup.bcf'])
    expect(archive.declaredSize('abc/markup.bcf')).toBe(9)
    expect(new TextDecoder().decode(archive.read('abc/markup.bcf') ?? new Uint8Array())).toBe('<Markup/>')
    expect(archive.read('nope')).toBeNull()
  })

  it.each(['../evil.bcf', '../../etc/passwd', 'a/../../b', '/etc/passwd', 'a\\..\\b', 'C:/x', 'a/b/c', './x', 'a//b'])(
    'refuses a member called %j as an unsafe path',
    (name) => {
      expect(opening(zip({ [name]: strToU8('x') }))).toBe('unsafe_path')
    }
  )

  it('refuses a member whose name carries a NUL', () => {
    const bytes = zip({ 'a/markupXbcf': strToU8('x') }, 0)
    bytes[centralEntry(bytes, 'a/markupXbcf') + 46 + 'a/markup'.length] = 0
    expect(opening(bytes)).toBe('unsafe_path')
  })

  it('refuses the same member twice', () => {
    const bytes = zip({ 'a/markup.bcf': strToU8('one'), 'b/markup.bcf': strToU8('two') }, 0)
    bytes.set(strToU8('a'), centralEntry(bytes, 'b/markup.bcf') + 46)
    expect(opening(bytes)).toBe('unsafe_path')
  })

  it('refuses sixteen directory entries that point at one compressed run, before inflating any', () => {
    const bomb = overlappingBomb()
    expect(bomb.length).toBeLessThan(64 * 1024)
    expect(() => openBcfArchive(bomb)).toThrow(/share bytes/)
  })

  it('refuses an XML part that declares more than its bound, and members that together declare more than the archive may', () => {
    expect(opening(zip({ 'a/markup.bcf': new Uint8Array(MAX_BCF_XML_MEMBER_BYTES + 1) }))).toBe('too_large')
    const files: Zippable = {}
    for (let index = 0; index < 5; index += 1) files[`t${index}/snapshot.png`] = new Uint8Array(15 * 1024 * 1024)
    expect(opening(zip(files))).toBe('too_large')
  })

  it('opens an archive whose picture is large and never inflates it unless read', () => {
    const archive = openBcfArchive(zip({ 'a/markup.bcf': strToU8('<Markup/>'), 'a/snapshot.png': new Uint8Array(8 * 1024 * 1024) }))
    expect(archive.declaredSize('a/snapshot.png')).toBe(8 * 1024 * 1024)
  })

  it('refuses, on reading, a bomb that lies about its size, the moment it inflates past what it declared', () => {
    const bytes = zip({ 'a/markup.bcf': new Uint8Array(MAX_BCF_XML_MEMBER_BYTES) })
    viewOf(bytes).setUint32(centralEntry(bytes, 'a/markup.bcf') + 24, 100, true)
    const archive = openBcfArchive(bytes)
    expect(refusal(() => archive.read('a/markup.bcf'))).toBe('too_large')
  })

  it('refuses more members than a BCF file of a full document has', () => {
    const files: Zippable = {}
    for (let index = 0; index <= MAX_BCF_ENTRIES; index += 1) files[`t${index}.txt`] = new Uint8Array(0)
    expect(opening(zip(files, 0))).toBe('too_many_entries')
  })

  it('refuses ZIP64, and a compression method other than stored or deflate', () => {
    const zip64 = zip({ 'a/markup.bcf': strToU8('<Markup/>') })
    viewOf(zip64).setUint16(endOfDirectory(zip64) + 10, 0xffff, true)
    expect(opening(zip64)).toBe('unsupported')
    const sized64 = zip({ 'a/markup.bcf': strToU8('<Markup/>') })
    viewOf(sized64).setUint32(centralEntry(sized64, 'a/markup.bcf') + 24, 0xffffffff, true)
    expect(opening(sized64)).toBe('unsupported')
    const bzip2 = zip({ 'a/markup.bcf': strToU8('<Markup/>') })
    viewOf(bzip2).setUint16(centralEntry(bzip2, 'a/markup.bcf') + 10, 12, true)
    expect(opening(bzip2)).toBe('unsupported')
  })

  it('refuses an encrypted member', () => {
    const bytes = zip({ 'a/markup.bcf': strToU8('<Markup/>') })
    const at = centralEntry(bytes, 'a/markup.bcf')
    viewOf(bytes).setUint16(at + 8, viewOf(bytes).getUint16(at + 8, true) | 1, true)
    expect(opening(bytes)).toBe('encrypted')
  })

  it('refuses, on reading, a member whose bytes do not match their CRC', () => {
    const bytes = zip({ 'a/markup.bcf': strToU8('<Markup>damaged</Markup>') }, 0)
    bytes[bytes.indexOf(strToU8('damaged')[0], 40)] ^= 0xff
    expect(refusal(() => openBcfArchive(bytes).read('a/markup.bcf'))).toBe('corrupt')
  })

  it('refuses bytes that are no ZIP archive', () => {
    expect(opening(strToU8('<?xml version="1.0"?><Markup/>'))).toBe('not_a_zip')
    expect(opening(new Uint8Array(4))).toBe('not_a_zip')
  })
})

describe('safeMemberPath', () => {
  it('takes the paths BCF writes', () => {
    for (const path of ['bcf.version', 'extensions.xml', 'project.bcfp', '0f0e6d6a-1b2c-4d3e-8f9a-0b1c2d3e4f5a/markup.bcf', 'abc/']) {
      expect(safeMemberPath(path)).toBe(path)
    }
  })
})
