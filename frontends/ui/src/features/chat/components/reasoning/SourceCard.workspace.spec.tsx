/**
 * A workspace read in the Herleitung (ADR-0125): the ledger names it by the
 * operation it ran (`shelf: 'workspace'`, `tools/workspace/register.py`), an
 * identifier. The slot is worded for the reader, with the operation beneath it,
 * and never drawn as a file.
 */

import { render, screen } from '@/test-utils'
import { describe, expect, test } from 'vitest'
import { sanitizeRetrievalLedger } from '@/lib/conversations/message-retrieval-ledger'
import { ledgerFan } from '../../lib/retrieval-rounds'
import { BareSourceCard } from './SourceCard'

const ledger = sanitizeRetrievalLedger([
  {
    index: 0,
    key: 'status.action.workspaceCall',
    tools: ['workspace__call'],
    docs: [
      { name: 'project-member-list', shelf: 'workspace', repeat: false },
      { name: 'Baubeschreibung.docx', repeat: false },
    ],
    new_docs: ['project-member-list', 'Baubeschreibung.docx'],
    hits: 2,
    documents: 2,
  },
])!

describe('a workspace read in the ledger', () => {
  test('is a workspace slot, and a file beside it is not', () => {
    const [read, file] = ledgerFan(ledger[0]!, [])
    expect(read).toMatchObject({ name: 'project-member-list', workspace: true })
    expect(file?.workspace).toBeUndefined()
  })

  test('is worded for the reader, with the operation as its identifier', () => {
    render(<BareSourceCard name="project-member-list" workspace />)
    expect(screen.getByText('Read from the workspace')).toBeInTheDocument()
    expect(screen.getByText('project-member-list')).toBeInTheDocument()
  })
})
