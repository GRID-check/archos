// @disk-inputs: ../aiq_api/src/aiq_api/chat_socket.py
/**
 * An ask's bound, pinned to the chat turn's own deadline.
 *
 * An ask still open past `DEFAULT_ASK_MAX_SECONDS` is ended `failed` when it is
 * next read. Below the turn's deadline it would end an ask whose turn may still
 * answer; far above it an ask whose outcome notice was lost reads `working` long
 * after nothing runs. So the deadline is read out of the socket that enforces it.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CHAT_TURN_DEADLINE_SECONDS, DEFAULT_ASK_MAX_SECONDS } from './ask-wire'

const CHAT_SOCKET = join(__dirname, '..', '..', '..', '..', 'aiq_api', 'src', 'aiq_api', 'chat_socket.py')

describe('the longest an ask stays open', () => {
  it('is the chat turn deadline the socket enforces', () => {
    const source = readFileSync(CHAT_SOCKET, 'utf8')
    const match = /CHAT_TURN_DEADLINE_SECONDS", "(\d+)"/.exec(source)
    expect(match, 'CHAT_TURN_DEADLINE_SECONDS default not found in chat_socket.py').not.toBeNull()
    expect(CHAT_TURN_DEADLINE_SECONDS).toBe(Number(match![1]))
  })

  it('outlasts that deadline by a grace for the outcome notice, and no more than a few minutes', () => {
    expect(DEFAULT_ASK_MAX_SECONDS).toBeGreaterThan(CHAT_TURN_DEADLINE_SECONDS)
    expect(DEFAULT_ASK_MAX_SECONDS - CHAT_TURN_DEADLINE_SECONDS).toBeLessThanOrEqual(300)
  })
})
