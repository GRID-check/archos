/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import type { ChatMessage, CitationSource } from '../types'
import { initialTurnView, type TurnView } from './turn-fold'
import { answerCompletionOf } from './answer-analytics'

const running = initialTurnView('turn-1', 'conv-1')
const ended = (patch: Partial<TurnView>): TurnView => ({ ...running, phase: 'finished', outcome: 'answered', ...patch })

const citation = (id: string, kind: CitationSource['kind']): CitationSource => ({
  id,
  content: 'x',
  timestamp: new Date(0),
  kind,
})

const answer = (patch: Partial<ChatMessage> = {}): ChatMessage => ({
  id: 'answer-1',
  role: 'assistant',
  content: 'text',
  timestamp: new Date(0),
  messageType: 'agent_response',
  ...patch,
})

describe('answerCompletionOf', () => {
  it('describes a grounded answer without naming a source', () => {
    const completion = answerCompletionOf(
      ended({}),
      running,
      answer({
        citations: [citation('a', 'baurecht'), citation('b', 'buero'), citation('c', 'baurecht')],
        reasoningEffort: 'medium',
      }),
      4200
    )
    expect(completion).toEqual({
      outcome: 'ok',
      duration_ms: 4200,
      citation_count: 3,
      source_kinds: 'baurecht,buero',
      effort: 'medium',
      has_run: false,
    })
  })

  it.each([
    [{ outcome: 'cancelled' as const }, 'aborted'],
    [{ outcome: 'refused' as const }, 'refused'],
    [{ outcome: 'handed_off' as const }, 'handed_off'],
    [{ phase: 'failed' as const, outcome: undefined }, 'error'],
  ])('maps %j to %s', (patch, outcome) => {
    expect(answerCompletionOf(ended(patch), running, undefined, undefined)?.outcome).toBe(outcome)
  })

  it('marks a turn that commissioned a run', () => {
    const view = ended({
      outcome: 'handed_off',
      result: { run: { run_id: 'r', run_message_id: 'm' } } as TurnView['result'],
    })
    expect(answerCompletionOf(view, running, undefined, 10)?.has_run).toBe(true)
  })

  it('counts a turn once: not while running, not on replay, not after a local Stop', () => {
    expect(answerCompletionOf(running, running, undefined, 1)).toBeNull()
    expect(answerCompletionOf(ended({}), undefined, undefined, 1)).toBeNull()
    expect(answerCompletionOf(ended({}), ended({ outcome: 'cancelled' }), undefined, 1)).toBeNull()
  })

  it('carries no text, title, file name or id', () => {
    const completion = answerCompletionOf(
      ended({}),
      running,
      answer({ content: 'Brüstungshöhe', citations: [{ ...citation('a', 'projekt'), title: 'Plan_EG.pdf', fileName: 'Plan_EG.pdf' }] }),
      1
    )
    expect(JSON.stringify(completion)).not.toMatch(/Brüstung|Plan_EG|turn-1|conv-1|answer-1/)
  })
})
