/**
 * The subagent groups under the Herleitung (AG-UI 1.0 `SUBAGENT_*`), drawn
 * from the recorded turn folded the way the app folds it.
 */
import { render, screen, within } from '@/test-utils'
import { describe, expect, test } from 'vitest'
import type { StoredThinkingStep } from '@/lib/conversations/message-provenance'
import { foldTurnEvents } from '../../lib/turn-fold'
import { wireEvents } from '@/test-utils/wire-v2-fixtures'
import { SubagentGroups, subagentGroups } from './SubagentGroups'

const recorded = (): StoredThinkingStep[] => {
  const view = foldTurnEvents(undefined, wireEvents('turn-subagents.jsonl'))
  if (!view) throw new Error('no events')
  return view.stepOrder.map((id) => view.steps[id])
}

describe('subagentGroups', () => {
  test('nests the planner, the researchers and the writer under deep research, in start order', () => {
    const [deep, ...others] = subagentGroups(recorded())
    expect(others).toEqual([])
    expect(deep.name).toBe('deep_researcher')
    expect(deep.children.map((child) => [child.name, child.status])).toEqual([
      ['planner-agent', 'ok'],
      ['researcher-agent', 'ok'],
      ['researcher-agent', 'error'],
      ['writer-agent', 'ok'],
    ])
    // Its own steps, not its children's: the task call and the round.
    expect(deep.steps.map((step) => step.id)).toEqual(['tool:4f1c', 'status:retrieval:1'])
    expect(deep.children[0].steps.map((step) => step.id)).toEqual(['tool:5a2d'])
  })

  test('a turn without a subagent has no groups', () => {
    const steps = recorded().filter(
      (step) => !step.id.startsWith('subagent:') && !step.subagentRunId
    )
    expect(subagentGroups(steps)).toEqual([])
  })
})

describe('SubagentGroups', () => {
  test('draws each subagent in the reader’s words, nested, with how it ended', () => {
    render(<SubagentGroups steps={recorded()} />)
    const region = screen.getByRole('region', { name: 'Subagents' })
    const groups = within(region).getAllByTestId('subagent-group')
    expect(groups.map((group) => group.dataset.status)).toEqual(['ok', 'ok', 'ok', 'error', 'ok'])
    expect(groups[0]).toHaveTextContent('Deep research')
    // The default matcher collapses the no-break space the count is written with.
    expect(within(groups[0]).getByText('2 steps')).toBeInTheDocument()
    expect(groups[3]).toHaveTextContent('Research')
    expect(groups[3]).toHaveTextContent('failed')
    expect(groups[3]).toHaveTextContent('Brandabschnittsgröße OIB-RL 2 Tabelle 1b')
  })

  test('draws nothing for a turn without a subagent', () => {
    const { container } = render(<SubagentGroups steps={[]} />)
    expect(container).toBeEmptyDOMElement()
  })
})
