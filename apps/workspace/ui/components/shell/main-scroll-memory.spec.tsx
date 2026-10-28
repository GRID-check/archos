import { act, render } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { MainScrollMemory } from './main-scroll-memory'

let pathname = '/app/projects'
vi.mock('next/navigation', () => ({ usePathname: () => pathname }))

/** jsdom keeps no scroll offset, so the landmark gets a plain one. */
function mountMain(): HTMLElement {
  const main = document.createElement('main')
  main.id = 'main-content'
  let top = 0
  Object.defineProperty(main, 'scrollTop', {
    get: () => top,
    set: (value: number) => {
      top = value
    },
  })
  document.body.append(main)
  return main
}

const frame = () => act(() => new Promise((resolve) => requestAnimationFrame(() => resolve(undefined))))

function go(to: string, traversal: boolean) {
  window.history.pushState(null, '', to)
  if (traversal) window.dispatchEvent(new PopStateEvent('popstate'))
  pathname = to
}

describe('MainScrollMemory', () => {
  afterEach(() => {
    document.getElementById('main-content')?.remove()
    pathname = '/app/projects'
    window.history.replaceState(null, '', '/')
  })

  test('Back returns the main column to where the reader left that page', async () => {
    const main = mountMain()
    go('/app/projects', false)
    const view = render(<MainScrollMemory />)

    main.scrollTop = 640
    main.dispatchEvent(new Event('scroll'))
    await frame()

    // A link: Next owns that scroll; the memory leaves it alone.
    go('/app/inbox', false)
    view.rerender(<MainScrollMemory />)
    main.scrollTop = 1200

    go('/app/projects', true)
    view.rerender(<MainScrollMemory />)
    expect(main.scrollTop).toBe(640)
  })

  test('a page never seen before opens at the top on a traversal', () => {
    const main = mountMain()
    go('/app/projects', false)
    const view = render(<MainScrollMemory />)
    main.scrollTop = 300

    go('/app/organization', true)
    view.rerender(<MainScrollMemory />)
    expect(main.scrollTop).toBe(0)
  })
})
