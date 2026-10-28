/**
 * @vitest-environment node
 */

/**
 * A formula card exported: its inputs as the source gives them, without the
 * field's own UI state. An input's `step` is the arrow-key increment, and must
 * not be printed as „Aus Schritt 0,5", the label a calculation operand's step
 * REFERENCE carries; that one stays.
 */

import { describe, expect, it } from 'vitest'
import { answerExportCopy } from '@/i18n/namespaces/answer-export'
import { cardBlocks } from './cards'
import type { DocBlock } from './blocks'

const t = (key: string): string =>
  key
    .split('.')
    .reduce<unknown>((node, part) => (node as Record<string, unknown>)?.[part], answerExportCopy.messages.de) as string

const text = (blocks: DocBlock[]): string =>
  blocks
    .map((block) =>
      block.kind === 'heading'
        ? block.text
        : block.kind === 'paragraph'
          ? block.runs.map((run) => run.text).join('')
          : block.kind === 'table'
            ? [block.head ?? [], ...block.rows.map((row) => row.map((cell) => cell.map((run) => run.text).join('')))]
                .map((row) => row.join(' | '))
                .join('\n')
            : ''
    )
    .join('\n')

describe('exporting a formula card', () => {
  it('prints the inputs and their sources, never the arrow-key step', () => {
    const exported = text(
      cardBlocks(
        {
          type: 'formula',
          title: 'Stiege Haus A',
          formula: {
            name: 'stair_step_rule',
            stair_type: 'main',
            riser: { value: 17, step: 0.5, source: 'Einreichplan, Schnitt A-A' },
            going: { value: 29, step: 0.5 },
          },
        },
        t
      )
    )
    expect(exported).toContain('Einreichplan, Schnitt A-A')
    expect(exported).toContain('17')
    expect(exported).not.toContain('Aus Schritt')
    expect(exported).not.toContain('0,5')
  })

  it('still prints a calculation operand’s step reference', () => {
    const exported = text(
      cardBlocks(
        {
          type: 'calculation',
          title: 'Geschossflächenzahl',
          steps: [
            {
              label: 'BGF',
              operation: 'sum',
              operands: [
                { label: 'EG', value: 400 },
                { label: 'OG', value: 380 },
              ],
            },
            {
              label: 'GFZ',
              operation: 'quotient',
              operands: [
                { label: 'BGF', step: 1 },
                { label: 'Bauplatz', value: 900 },
              ],
            },
          ],
        },
        t
      )
    )
    expect(exported).toContain('Aus Schritt')
  })
})
