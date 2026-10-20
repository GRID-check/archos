import { render, screen } from '@/test-utils'
import { describe, test, expect } from 'vitest'
import { OfficeShelfEntryCard } from './office-shelf-entry-card'

describe('ArchivEntryCard', () => {
  test('links to Office filing with title and explainer', () => {
    render(<OfficeShelfEntryCard />)

    const link = screen.getByRole('link', { name: /office filing/i })
    expect(link).toHaveAttribute('href', '/app/office-shelf')
    expect(screen.getByText('Office filing')).toBeInTheDocument()
    expect(screen.getByText(/organization-wide knowledge/i)).toBeInTheDocument()
  })
})
