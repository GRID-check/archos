/**
 * A BCF file someone else wrote, opened with every bound checked: the ZIP half
 * of the import (`./bcf-import-service.ts`). The XML half is `./bcf-xml.ts`.
 *
 * ## Why not `unzipSync`
 *
 * fflate (already a dependency) does the inflating. Its one-call `unzipSync`
 * trusts the sizes the archive declares and inflates every member up front.
 * Here the central directory (what every unzip tool reads, not the local
 * headers) is walked first and the whole archive admitted or refused before a
 * byte is inflated; then a member is inflated only when the reader asks for it
 * ({@link BcfArchive.read}), through fflate's streaming `Inflate` in small
 * chunks, counted as it comes out: the moment one yields more than it declared,
 * the archive is refused. Nothing is ever written to disk, so a path is only a
 * map key; a path that climbs is still refused, because a BCF writer never
 * makes one.
 *
 * ## The bounds, all checked on the directory before anything inflates
 *
 * - Members: at most {@link MAX_BCF_ENTRIES}, each name once.
 * - Bytes: at most {@link MAX_BCF_UNPACKED_BYTES} declared for all members
 *   together, and an XML part (`.bcf`, `.bcfv`, `.bcfp`, `.xml`, `.version`)
 *   at most {@link MAX_BCF_XML_MEMBER_BYTES}. A picture is not bounded here:
 *   the reader skips one that declares more than a snapshot may hold, without
 *   inflating it. What actually inflates is counted against what was declared.
 * - Layout: no two members share bytes. Sixteen directory entries pointing at
 *   one compressed run would inflate it sixteen times; each member's local
 *   header and data must lie in a range no other member's touches.
 *
 * | Refusal | When |
 * |---|---|
 * | `not_a_zip` | no end-of-central-directory record, or one that points outside the bytes |
 * | `too_many_entries` | more than {@link MAX_BCF_ENTRIES} members |
 * | `unsafe_path` | an absolute path, a drive, a backslash, `.` or `..`, a NUL, deeper than a topic folder, or the same name twice |
 * | `too_large` | past a bound above, declared or inflated |
 * | `encrypted` | an encrypted member |
 * | `unsupported` | a compression method other than stored or deflate, or ZIP64 |
 * | `corrupt` | a header that does not hold together, members that overlap, or a CRC that does not match |
 *
 * Pure: no `server-only`, no I/O.
 */

import { Inflate } from 'fflate'
import type { BcfArchiveRefusal } from './bcf-import-wire'
import { crc32 } from './zip'

/** The largest BCF file the import takes: a coordination round of a few hundred topics with their pictures. */
export const MAX_BCF_ARCHIVE_BYTES = 64 * 1024 * 1024
/** Members of one archive: four per topic (folder, markup, viewpoint, picture) for a full document, and the root files. */
export const MAX_BCF_ENTRIES = 2_500
/** What all members together may declare. Pictures are stored, not deflated, so this is about the archive's own size. */
export const MAX_BCF_UNPACKED_BYTES = 64 * 1024 * 1024
/** One XML part, inflated: a viewpoint of 2000 exceptions is well under 1 MiB. */
export const MAX_BCF_XML_MEMBER_BYTES = 4 * 1024 * 1024
/** A member's name, in bytes. */
const MAX_PATH_LENGTH = 255
/** Compressed bytes handed to the inflater at once: bounds what one push can produce to about a thousandfold. */
const INFLATE_CHUNK = 4 * 1024

const XML_MEMBER = /\.(bcf|bcfv|bcfp|xml|version)$/i

export class BcfArchiveError extends Error {
  constructor(
    readonly reason: BcfArchiveRefusal,
    message: string
  ) {
    super(message)
    this.name = 'BcfArchiveError'
  }
}

const refuse = (reason: BcfArchiveRefusal, message: string): never => {
  throw new BcfArchiveError(reason, message)
}

interface Member {
  path: string
  method: number
  crc: number
  compressedSize: number
  size: number
  localOffset: number
  /** Where its data starts, read from its local header at admission. */
  dataStart: number
}

/** An admitted archive: its file paths, and each file's bytes on demand. */
export interface BcfArchive {
  /** The files (folders left out), in directory order. */
  readonly paths: readonly string[]
  has(path: string): boolean
  /** What the member declares it inflates to, or null for no such file. */
  declaredSize(path: string): number | null
  /** The member's bytes, inflated now and counted; null for no such file. Refuses with {@link BcfArchiveError}. */
  read(path: string): Uint8Array | null
}

const EOCD = 0x06054b50
const CENTRAL = 0x02014b50
const LOCAL = 0x04034b50
const ZIP64_MARK = 0xffffffff

function findEndOfDirectory(view: DataView): number {
  const last = view.byteLength - 22
  const first = Math.max(0, last - 0xffff)
  for (let at = last; at >= first; at -= 1) {
    if (view.getUint32(at, true) === EOCD) return at
  }
  return refuse('not_a_zip', 'no end-of-central-directory record')
}

/**
 * A member name as a map key, or a refusal. BCF's own layout is two levels deep
 * at most: `bcf.version`, `<topic guid>/markup.bcf`.
 */
export function safeMemberPath(name: string): string {
  if (name.length === 0 || name.length > MAX_PATH_LENGTH) refuse('unsafe_path', 'empty or overlong member name')
  if (/[\\\0:]/.test(name) || name.startsWith('/')) refuse('unsafe_path', `unsafe member name ${JSON.stringify(name)}`)
  const segments = name.replace(/\/$/, '').split('/')
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    refuse('unsafe_path', `member name climbs or is empty: ${JSON.stringify(name)}`)
  }
  if (segments.length > 2) refuse('unsafe_path', `member nested too deep: ${JSON.stringify(name)}`)
  return name
}

const decoder = new TextDecoder('utf-8', { fatal: false })

function readDirectory(bytes: Uint8Array, view: DataView): Member[] {
  const end = findEndOfDirectory(view)
  const count = view.getUint16(end + 10, true)
  const size = view.getUint32(end + 12, true)
  const offset = view.getUint32(end + 16, true)
  if (count === 0xffff || offset === ZIP64_MARK) refuse('unsupported', 'ZIP64 archives are not read')
  if (count > MAX_BCF_ENTRIES) refuse('too_many_entries', `${count} members`)
  if (offset + size > end) refuse('not_a_zip', 'central directory outside the archive')
  const members: Member[] = []
  let at = offset
  for (let index = 0; index < count; index += 1) {
    if (at + 46 > end || view.getUint32(at, true) !== CENTRAL) refuse('corrupt', 'bad central directory entry')
    const flags = view.getUint16(at + 8, true)
    const nameLength = view.getUint16(at + 28, true)
    const next = at + 46 + nameLength + view.getUint16(at + 30, true) + view.getUint16(at + 32, true)
    if (next > end) refuse('corrupt', 'central directory entry runs past its end')
    if (flags & 0x1) refuse('encrypted', 'an encrypted member')
    const compressedSize = view.getUint32(at + 20, true)
    const memberSize = view.getUint32(at + 24, true)
    const localOffset = view.getUint32(at + 42, true)
    if (compressedSize === ZIP64_MARK || memberSize === ZIP64_MARK || localOffset === ZIP64_MARK) {
      refuse('unsupported', 'ZIP64 members are not read')
    }
    if (localOffset + 30 > offset || view.getUint32(localOffset, true) !== LOCAL) refuse('corrupt', 'bad local header')
    const dataStart = localOffset + 30 + view.getUint16(localOffset + 26, true) + view.getUint16(localOffset + 28, true)
    if (dataStart + compressedSize > offset) refuse('corrupt', 'member data runs into the central directory')
    members.push({
      path: safeMemberPath(decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength))),
      method: view.getUint16(at + 10, true),
      crc: view.getUint32(at + 16, true),
      compressedSize,
      size: memberSize,
      localOffset,
      dataStart,
    })
    at = next
  }
  return members
}

/** Check the directory as a whole before anything is inflated: names unique, no shared bytes, sizes within bounds as declared. */
function admit(members: readonly Member[]): void {
  const seen = new Set<string>()
  let total = 0
  for (const member of members) {
    const key = member.path.toLowerCase()
    if (seen.has(key)) refuse('unsafe_path', `the member ${JSON.stringify(member.path)} appears twice`)
    seen.add(key)
    if (member.method !== 0 && member.method !== 8) refuse('unsupported', `compression method ${member.method}`)
    if (XML_MEMBER.test(member.path) && member.size > MAX_BCF_XML_MEMBER_BYTES) refuse('too_large', `an XML part of ${member.size} bytes`)
    total += member.size
    if (total > MAX_BCF_UNPACKED_BYTES) refuse('too_large', 'the members together are too large')
  }
  const ranges = [...members].sort((a, b) => a.localOffset - b.localOffset)
  for (let index = 1; index < ranges.length; index += 1) {
    const before = ranges[index - 1]
    if (ranges[index].localOffset < before.dataStart + before.compressedSize) refuse('corrupt', 'two members share bytes')
  }
}

/** Inflate one member in small pushes, refusing the moment it yields more than it declared. */
function inflateBounded(compressed: Uint8Array, declared: number): Uint8Array {
  const out = new Uint8Array(declared)
  let written = 0
  let ended = false
  const inflater = new Inflate((chunk, final) => {
    if (written + chunk.length > declared) refuse('too_large', 'a member inflates past its declared size')
    out.set(chunk, written)
    written += chunk.length
    if (final) ended = true
  })
  try {
    for (let at = 0; at < compressed.length; at += INFLATE_CHUNK) {
      const end = Math.min(at + INFLATE_CHUNK, compressed.length)
      inflater.push(compressed.subarray(at, end), end === compressed.length)
    }
  } catch (error) {
    if (error instanceof BcfArchiveError) throw error
    refuse('corrupt', 'a member does not inflate')
  }
  if (!ended || written !== declared) refuse('corrupt', 'a member inflates to another size than it declared')
  return out
}

function memberBytes(bytes: Uint8Array, member: Member): Uint8Array {
  const compressed = bytes.subarray(member.dataStart, member.dataStart + member.compressedSize)
  if (member.method === 0 && member.compressedSize !== member.size) refuse('corrupt', 'a stored member with two sizes')
  const data = member.method === 0 ? compressed : inflateBounded(compressed, member.size)
  if (crc32(data) !== member.crc) refuse('corrupt', `CRC mismatch for ${member.path}`)
  return data
}

/**
 * Open a BCF archive: the directory is admitted or the whole archive refused
 * ({@link BcfArchiveError}); members inflate only when read, each at most once.
 */
export function openBcfArchive(bytes: Uint8Array): BcfArchive {
  if (bytes.length > MAX_BCF_ARCHIVE_BYTES) refuse('too_large', 'the archive is too large')
  if (bytes.length < 22) refuse('not_a_zip', 'too short for a ZIP archive')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const members = readDirectory(bytes, view)
  admit(members)
  const files = new Map(members.filter((member) => !member.path.endsWith('/')).map((member) => [member.path, member]))
  return {
    paths: [...files.keys()],
    has: (path) => files.has(path),
    declaredSize: (path) => files.get(path)?.size ?? null,
    read: (path) => {
      const member = files.get(path)
      return member ? memberBytes(bytes, member) : null
    },
  }
}
