/**
 * Marks the caller headless (`X-Chat-Mode: headless`): the backend skips the
 * clarifier, and `ask_user` refuses instead of waiting on a socket nobody reads.
 *
 * Sent under its name from before ADR-0145 (row 10b) too, for one release: the
 * BFF rolls out before the chat tier, which reads only the old name until it
 * has. A leaf, so a spec that mocks the turn driver keeps the real headers.
 */
export const HEADLESS_MODE_HEADERS = { 'x-chat-mode': 'headless', 'x-aiq-mode': 'headless' } as const
