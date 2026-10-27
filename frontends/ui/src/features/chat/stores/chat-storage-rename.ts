/**
 * The chat store's keys under a name it no longer has.
 *
 * The store was `aiq-chat-store`, after the blueprint the platform started from,
 * and is `grid-chat-store` (ADR-0145 row 10d). A browser that last ran the old
 * name holds its conversation list and drafts only there, so the keys move
 * before the store first reads. Remove this, and the old name in `store.ts`,
 * one release after it ships.
 */

/** Is `key` the store's single key (`name`) or one of its `name:…` keys? */
const belongsTo = (key: string, name: string): boolean => key === name || key.startsWith(`${name}:`)

/**
 * Move every key of the store `from` to the same key under `to`, once: a
 * browser that already holds `to`'s index is left alone, and the old keys are
 * dropped then. One key at a time, the index last, so a full quota costs at
 * most a cached conversation's messages (the server holds them), never the
 * list.
 */
export function moveStoredChat(from: string, to: string): void {
  const keys: string[] = []
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i)
    if (key !== null && belongsTo(key, from)) keys.push(key)
  }
  if (keys.length === 0) return
  const moveTo = localStorage.getItem(`${to}:index`) === null
  const index = `${from}:index`
  for (const key of [...keys.filter((k) => k !== index), ...keys.filter((k) => k === index)]) {
    const value = localStorage.getItem(key)
    localStorage.removeItem(key)
    if (!moveTo || value === null) continue
    try {
      localStorage.setItem(`${to}${key.slice(from.length)}`, value)
    } catch {
      // Out of room: this key's messages are fetched again when the
      // conversation opens. The index is last, after every other key freed its room.
    }
  }
}
