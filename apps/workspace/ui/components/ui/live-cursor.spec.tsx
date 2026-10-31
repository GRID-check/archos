import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { LiveCursor, PeerTag } from './live-cursor'

describe('PeerTag', () => {
  // The review named one colleague in three shapes: a control-radius tag at the
  // pointer, a 10px pill at the mark they had open, a square tab on the box
  // they drew, some in `text-background`, which goes dark on their ink at night.
  it('is the tag beside the pointer: control radius, 11px, white on their ink', () => {
    render(
      <>
        <PeerTag color="rgb(1, 2, 3)" data-testid="tag">
          Anna
        </PeerTag>
        <LiveCursor color="rgb(1, 2, 3)" label="Anna Berger" />
      </>
    )
    const tag = screen.getByTestId('tag')
    const cursorTag = document.querySelector('[data-slot="live-cursor-tag"]') as HTMLElement
    for (const name of ['rounded-control', 'text-[11px]', 'text-white', 'shadow-md']) {
      expect(tag.className).toContain(name)
      expect(cursorTag.className).toContain(name)
    }
    expect(tag.className).not.toContain('text-background')
    expect(tag).toHaveStyle({ backgroundColor: 'rgb(1, 2, 3)' })
  })

  it('becomes the face of a button with asChild', () => {
    render(
      <PeerTag asChild color="red">
        <button type="button">Anna · Seite 2</button>
      </PeerTag>
    )
    const button = screen.getByRole('button', { name: 'Anna · Seite 2' })
    expect(button).toHaveAttribute('data-slot', 'peer-tag')
    expect(button.className).toContain('rounded-control')
  })
})
