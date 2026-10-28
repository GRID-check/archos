/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import { readDrop, readDroppedTree } from './dropped-entries'

/** A minimal stand-in for the entries API, shaped like the real one. */
type Entry = {
  isFile: boolean
  isDirectory: boolean
  name: string
  file?: (ok: (f: File) => void, err: (e: unknown) => void) => void
  createReader?: () => {
    readEntries: (ok: (e: Entry[]) => void, err: (e: unknown) => void) => void
  }
}

const fileEntry = (name: string): Entry => ({
  isFile: true,
  isDirectory: false,
  name,
  file: (ok) => ok({ name, size: 1 } as unknown as File),
})

/**
 * A directory that hands out its children 100 at a time and then an empty
 * batch, exactly as the browser does. The batching is the point: a reader that
 * calls `readEntries` once sees the first 100 and believes it is finished.
 */
const dirEntry = (name: string, children: Entry[]): Entry => {
  let cursor = 0
  return {
    isFile: false,
    isDirectory: true,
    name,
    createReader: () => ({
      readEntries: (ok) => {
        const batch = children.slice(cursor, cursor + 100)
        cursor += batch.length
        ok(batch)
      },
    }),
  }
}

const transferOf = (entries: Entry[]): DataTransfer =>
  ({
    items: entries.map((entry) => ({
      kind: 'file',
      webkitGetAsEntry: () => entry,
    })),
  }) as unknown as DataTransfer

describe('readDroppedTree', () => {
  it('reads a dropped folder, which dataTransfer.files cannot see at all', async () => {
    const tree = await readDroppedTree(
      transferOf([dirEntry('Wohnbau Nord', [fileEntry('EG.pdf'), fileEntry('OG.pdf')])])
    )

    expect(tree?.files.map((f) => f.relativePath).sort()).toEqual([
      'Wohnbau Nord/EG.pdf',
      'Wohnbau Nord/OG.pdf',
    ])
  })

  it('carries the whole path down a nested tree', async () => {
    const tree = await readDroppedTree(
      transferOf([
        dirEntry('Wohnbau Nord', [dirEntry('03_Einreichung', [fileEntry('Grundriss.pdf')])]),
      ])
    )

    expect(tree?.files[0]?.relativePath).toBe('Wohnbau Nord/03_Einreichung/Grundriss.pdf')
  })

  it('drains a directory rather than taking its first batch for the whole of it', async () => {
    // 250 files is three `readEntries` calls. A single read returns 100 and
    // looks complete, which would silently drop 150 files from an upload.
    const many = Array.from({ length: 250 }, (_, i) => fileEntry(`plan_${i}.pdf`))

    const tree = await readDroppedTree(transferOf([dirEntry('Plaene', many)]))

    expect(tree?.files).toHaveLength(250)
    expect(tree?.truncated).toBe(false)
  })

  it('gives a loose file no fabricated path', async () => {
    const tree = await readDroppedTree(transferOf([fileEntry('einzeln.pdf')]))

    expect(tree?.files[0]?.relativePath).toBeUndefined()
  })

  it('reports truncation rather than quietly taking a prefix', async () => {
    // A silently truncated bulk upload is worse than a refused one: the missing
    // files are indistinguishable from files nobody uploaded.
    const tooMany = Array.from({ length: 2500 }, (_, i) => fileEntry(`f_${i}.pdf`))

    const tree = await readDroppedTree(transferOf([dirEntry('Riesig', tooMany)]))

    expect(tree?.truncated).toBe(true)
  })

  it('returns null when the browser exposes no entries, so the caller can fall back', async () => {
    expect(await readDroppedTree({ items: [] } as unknown as DataTransfer)).toBeNull()
  })
})

const failingFileEntry = (name: string): Entry => ({
  isFile: true,
  isDirectory: false,
  name,
  file: (_ok, err) => err(new Error('cloud-only')),
})

/** A drop as the browser hands it over: entries where it has them, plain files where it does not. */
const dropOf = (items: Array<{ entry?: Entry; file?: File }>, listed: File[] = []): DataTransfer =>
  ({
    items: items.map(({ entry, file }) => ({
      kind: 'file',
      webkitGetAsEntry: () => entry ?? null,
      getAsFile: () => file ?? null,
    })),
    files: listed,
  }) as unknown as DataTransfer

const named = (name: string) => ({ name, size: 1, type: 'application/pdf' }) as unknown as File

describe('readDrop', () => {
  it('keeps a file the entries API does not see when it is dropped beside a folder (an Outlook attachment)', async () => {
    const drop = await readDrop(
      dropOf([{ entry: dirEntry('Wohnbau Nord', [fileEntry('EG.pdf')]) }, { file: named('Anhang.pdf') }])
    )

    expect(drop.files.map((file) => file.name).sort()).toEqual(['Anhang.pdf', 'EG.pdf'])
  })

  it('reads an empty folder as an empty drop, never as the folder itself posing as a file', async () => {
    const folderAsFile = { name: 'Leer', size: 0, type: '' } as unknown as File
    const drop = await readDrop(dropOf([{ entry: dirEntry('Leer', []) }], [folderAsFile]))

    expect(drop.files).toEqual([])
  })

  it('counts the files it could not read instead of losing them without a word', async () => {
    const drop = await readDrop(dropOf([{ entry: dirEntry('Cloud', [fileEntry('da.pdf'), failingFileEntry('nur-online.pdf')]) }]))

    expect(drop.files.map((file) => file.name)).toEqual(['da.pdf'])
    expect(drop.unreadable).toBe(1)
  })

  it('skips a NAS thumbnail cache and a version-control store inside a dropped folder', async () => {
    const drop = await readDrop(
      dropOf([
        {
          entry: dirEntry('Projekt', [
            fileEntry('Plan.pdf'),
            dirEntry('@eaDir', [fileEntry('SYNOFILE_THUMB_M.jpg')]),
            dirEntry('.git', [fileEntry('HEAD')]),
          ]),
        },
      ])
    )

    expect(drop.files.map((file) => file.name)).toEqual(['Plan.pdf'])
  })

  it('says when a bound cut the drop short', async () => {
    const tooMany = Array.from({ length: 2500 }, (_, i) => fileEntry(`f_${i}.pdf`))
    const drop = await readDrop(dropOf([{ entry: dirEntry('Riesig', tooMany) }]))

    expect(drop.truncated).toBe(true)
  })

  it('falls back to the plain file list when the browser has no entries API', async () => {
    const listed = [named('a.pdf'), named('b.pdf')]
    const drop = await readDrop({ items: [], files: listed } as unknown as DataTransfer)

    expect(drop.files).toEqual(listed)
  })
})
