/**
 * @vitest-environment node
 */
/**
 * Every reason a wake can store, classed as the inbox words it. The strings are
 * the ones the writers produce on this branch: the wake job
 * (`./wake-job.ts`), the BFF's budget refusal (`TurnBudgetExhaustedError`),
 * the headless socket's `unavailable` reasons (`lib/turns/headless-turn.ts`),
 * the turn's outcome (`lib/turns/outcome.ts`, `DEFAULT_FAILURE_REASON`), and
 * the agent's refusals and `RUN_ERROR` messages (`common/turn_admission.py`,
 * `common/cost_tracking.py`, `backend/chat_socket.py` `_error_for` and its turn
 * fence, `backend/jobs/submit.py`). A new writer adds its string here.
 */
import { describe, expect, it } from 'vitest'
import { DEFAULT_FAILURE_REASON } from '@/lib/turns/outcome'
import { TurnBudgetExhaustedError } from '@/lib/turns/turn-context'
import { WAKE_END_REASON_KINDS, wakeEndReasonKind } from './wake-end-reason'

describe('wakeEndReasonKind', () => {
  it.each([
    // The wake job.
    ['refused', `budget: ${new TurnBudgetExhaustedError('user').message}`, 'budget'],
    ['refused', `budget: ${new TurnBudgetExhaustedError(null).message}`, 'budget'],
    ['failed', 'gave up waiting: another turn of the thread ran', 'busy'],
    ['failed', 'gave up waiting: the thread is being deleted', 'busy'],
    ['failed', 'gave up waiting: no answer in time', 'busy'],
    ['failed', 'gave up waiting: socket 1006', 'busy'],
    ['failed', 'gave up waiting: the server does not read user_message.if_idle', 'busy'],
    ['failed', 'gave up waiting: the socket would not take the message', 'busy'],
    ['failed', 'rejected: auth_expired', 'access'],
    ['failed', 'rejected: conversation_mismatch', 'access'],
    ['failed', 'rejected: conversation_mismatch (The envelope names another thread.)', 'access'],
    ['failed', 'rejected: invalid_message', 'error'],
    ['failed', 'rejected: invalid_message (Unknown message type.)', 'error'],
    // The refusal's own words, from the job (refused) or the turn's outcome (failed).
    ['refused', "The organization's LLM budget is exhausted (limit scope: organization). An org admin can raise limits under Organization → Usage & budgets.", 'budget'],
    ['failed', "The organization's LLM budget is exhausted (limit scope: user). An org admin can raise limits under Organization → Usage & budgets.", 'budget'],
    ['refused', 'The assistant is busy right now. Please send your message again in a moment.', 'busy'],
    ['failed', 'Your organization already has several answers in progress. Please wait for one to finish.', 'busy'],
    ['failed', 'The assistant is still finishing the previous answer. Please send your message again in a moment.', 'busy'],
    ['failed', 'The assistant cannot start a new answer right now. Please send your message again in a moment.', 'busy'],
    ['failed', 'Your organization already has 12 research jobs waiting. Please let some of them start before adding more.', 'busy'],
    ['refused', 'refused', 'error'],
    // `RUN_ERROR` messages (the chat socket's `_error_for`), and the outcome's fallbacks.
    ['failed', 'auth_error', 'access'],
    ['failed', 'token_expired', 'access'],
    ['failed', 'token_invalid', 'access'],
    ['failed', 'The question was not answered in time.', 'error'],
    ['failed', 'The answer took too long and was stopped. Please ask again, perhaps more narrowly.', 'error'],
    ['failed', 'The assistant hit an unexpected error while handling your request. Please try again.', 'error'],
    ['failed', 'failed', 'error'],
    ['failed', DEFAULT_FAILURE_REASON, 'error'],
    ['failed', 'something nobody wrote down yet', 'error'],
  ] as const)('%s „%s" is %s', (status, reason, kind) => {
    expect(wakeEndReasonKind(status, reason)).toBe(kind)
  })

  it('is null exactly when there is no failure to class', () => {
    expect(wakeEndReasonKind('answered', null)).toBeNull()
    expect(wakeEndReasonKind('stopped', 'stopped by Anna')).toBeNull()
    expect(wakeEndReasonKind('suppressed', 'cap:person-day')).toBeNull()
    expect(wakeEndReasonKind('failed', null)).toBeNull()
    expect(wakeEndReasonKind('refused', '  ')).toBeNull()
  })

  it('names four classes, the ones the inbox has words for', () => {
    expect(WAKE_END_REASON_KINDS).toEqual(['budget', 'busy', 'access', 'error'])
  })
})
