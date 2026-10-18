import { render } from '@/test-utils'
import { describe, expect, it, vi } from 'vitest'
import type { ConnectionPresence } from '@/shared/hooks/use-connection-presence'
import { ConnectionBand } from './connection-band'

let presence: ConnectionPresence = 'connected'
vi.mock('@/shared/hooks/use-connection-presence', () => ({
  useConnectionPresence: () => presence,
}))

describe('ConnectionBand', () => {
  it('takes no room while connected, and stays in the tree so the change is announced', () => {
    presence = 'connected'
    const { container } = render(<ConnectionBand appearance="line" />)

    const band = container.querySelector('[data-slot="connection-band"]')
    expect(band).toHaveClass('sr-only')
    expect(band).not.toHaveClass('h-6')
  })

  it('is a thin line of text, not a bordered card, when the chat toolbar asks for the line', () => {
    presence = 'reconnecting'
    const { container } = render(<ConnectionBand appearance="line" />)

    const band = container.querySelector('[data-slot="connection-band"]')
    expect(band).toHaveClass('h-6')
    expect(band).not.toHaveClass('border-t')
    expect(band).not.toHaveClass('sr-only')
  })

  it('keeps the header’s ruled band by default', () => {
    presence = 'offline'
    const { container } = render(<ConnectionBand />)

    expect(container.querySelector('[data-slot="connection-band"]')).toHaveClass('border-t', 'h-7')
  })
})
