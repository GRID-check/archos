import { describe, expect, it } from 'vitest'
import { render, screen } from '@/test-utils'
import { DocumentStatusBadge } from './document-status'

describe('DocumentStatusBadge queue position', () => {
  it("says how many of the office's uploads are ahead while the document waits", () => {
    render(<DocumentStatusBadge status="pending" queueAhead={3} />)
    expect(screen.getByText('Waiting · 3 files ahead')).toBeInTheDocument()
  })

  it('keeps the status word when nothing is ahead, or the document has settled', () => {
    const { rerender } = render(<DocumentStatusBadge status="pending" queueAhead={0} />)
    expect(screen.queryByText(/ahead/)).toBeNull()
    rerender(<DocumentStatusBadge status="completed" queueAhead={3} />)
    expect(screen.queryByText(/ahead/)).toBeNull()
  })
})

describe('DocumentStatusBadge state', () => {
  it('says the file is uploading while the bytes arrive, not that it is being read', () => {
    render(<DocumentStatusBadge status="uploading" />)
    const badge = screen.getByText('Uploading')
    expect(badge).toHaveAttribute('data-variant', 'info')
  })

  it('keeps a failed read failed', () => {
    render(<DocumentStatusBadge status="failed" />)
    expect(screen.getByText('Failed')).toHaveAttribute('data-variant', 'destructive')
  })
})
