import { beforeEach, describe, expect, test } from 'vitest'
import { RENAMED_STORAGE_KEYS, RENAMED_STORAGE_PREFIXES, STORAGE_RENAME_BOOT_SCRIPT } from './storage-rename-boot'

const run = (): void => {
  // Shipped into <head> as a string; evaluating it is what the browser does.
  new Function(STORAGE_RENAME_BOOT_SCRIPT)()
}

describe('STORAGE_RENAME_BOOT_SCRIPT', () => {
  beforeEach(() => {
    localStorage.clear()
    sessionStorage.clear()
  })

  test('carries exactly the declared maps in its literal', () => {
    expect(STORAGE_RENAME_BOOT_SCRIPT).toContain(`var k=${JSON.stringify(RENAMED_STORAGE_KEYS)};`)
    expect(STORAGE_RENAME_BOOT_SCRIPT).toContain(`var p=${JSON.stringify(RENAMED_STORAGE_PREFIXES)};`)
  })

  test('names no new key after a brand', () => {
    const fresh = [...Object.values(RENAMED_STORAGE_KEYS), ...Object.values(RENAMED_STORAGE_PREFIXES)]
    expect(fresh.filter((key) => /(?:^|[.:_-])(?:grid|piloti|aiq)(?:[.:_-]|$)/i.test(key))).toEqual([])
  })

  test('moves a value to its new key and deletes the old one, in both storages', () => {
    localStorage.setItem('grid.sidebar.collapsed', 'true')
    sessionStorage.setItem('grid.return-trail', '["/a"]')
    run()
    expect(localStorage.getItem('sidebar.collapsed')).toBe('true')
    expect(localStorage.getItem('grid.sidebar.collapsed')).toBeNull()
    expect(sessionStorage.getItem('return-trail')).toBe('["/a"]')
    expect(sessionStorage.getItem('grid.return-trail')).toBeNull()
  })

  test('keeps a value already written under the new key', () => {
    localStorage.setItem('grid.files.view', 'grid')
    localStorage.setItem('files.view', 'list')
    run()
    expect(localStorage.getItem('files.view')).toBe('list')
    expect(localStorage.getItem('grid.files.view')).toBeNull()
  })

  test('moves keys by prefix, each with its own suffix', () => {
    localStorage.setItem('piloti.mailImport.file.a1', 'x')
    localStorage.setItem('piloti.mailImport.file.b2', 'y')
    localStorage.setItem('unrelated', 'z')
    run()
    expect(localStorage.getItem('mailImport.file.a1')).toBe('x')
    expect(localStorage.getItem('mailImport.file.b2')).toBe('y')
    expect(localStorage.getItem('piloti.mailImport.file.a1')).toBeNull()
    expect(localStorage.getItem('unrelated')).toBe('z')
  })

  test('changes nothing on a second load', () => {
    localStorage.setItem('grid-layout', '{"state":{"theme":"dark"}}')
    run()
    const after = JSON.stringify({ ...localStorage })
    run()
    expect(JSON.stringify({ ...localStorage })).toBe(after)
  })
})
